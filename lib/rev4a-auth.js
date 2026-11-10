import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import * as fs from "fs";
import { createHash, timingSafeEqual, randomBytes } from "crypto";
import { ENV_FILE } from "@/lib/rev4a-paths";
import { unquoteEnvValue } from "@/lib/env-file";
import { passwordFingerprint, fingerprintEquals } from "./session-fingerprint.js";

export { passwordFingerprint, fingerprintEquals };

// ---------------------------------------------------------------------------
// Single source of truth for secret resolution. Every route and proxy.ts
// import these instead of keeping their own env+file-fallback copy — the
// duplication used to drift (proxy.ts had an env-only version because it
// used to run on Edge runtime, which can't use fs; now that it runs on
// Node.js runtime the split serves no purpose and only risks desync).
//
// In the supported `rev4a serve` flow the file fallback is rarely hit:
// bin/rev4a.js injects these into the Next.js child's env (writeEnvVar() also
// updates process.env in-process, for callers that use it). It exists for setups that bypass the CLI
// (a hand-written systemd unit, `npm run dev` before .env exists).
// ---------------------------------------------------------------------------
const PASSWORD_RE = /^REV4A_PASSWORD=(.*)$/m;
const JWT_SECRET_RE = /^REV4A_JWT_SECRET=(.*)$/m;

function readEnvFileValue(re) {
  try {
    if (fs.existsSync(ENV_FILE)) {
      const match = fs.readFileSync(ENV_FILE, "utf-8").match(re);
      if (match && match[1].trim()) return unquoteEnvValue(match[1]);
    }
  } catch { /* ignore */ }
  return "";
}

export function getPassword() {
  return process.env.REV4A_PASSWORD || readEnvFileValue(PASSWORD_RE);
}

export function getJwtSecret() {
  return process.env.REV4A_JWT_SECRET || readEnvFileValue(JWT_SECRET_RE);
}

export function isConfigured() {
  return getPassword().length > 0;
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Cookie (JWT) auth bound to the current effective password, falling back to
 * `Authorization: Bearer <REV4A_TOKEN>`.
 * Returns null when authorized, or a 401 response to return as-is.
 */
export async function requireAuthJWT(request) {
  const cookieToken = request.cookies?.get?.("rev4a_token")?.value;
  const secret = getJwtSecret();

  // An empty secret would mean verifying against a zero-length HMAC key.
  // jose rejects that, but bail explicitly rather than relying on it.
  if (cookieToken && secret) {
    try {
      const { payload } = await jwtVerify(cookieToken, new TextEncoder().encode(secret));
      const password = getPassword();
      if (password && fingerprintEquals(payload.pwf, passwordFingerprint(password, secret))) return null;
    } catch { /* fall through to bearer */ }
  }

  // Only the server-side variable: anything named NEXT_PUBLIC_* is inlined into the
  // browser bundle by Next.js, so accepting one here would hand the API token to every
  // visitor of the dashboard the moment an operator set it.
  const expectedToken = process.env.REV4A_TOKEN || "";
  // Without this guard an unset token would make `Bearer ` match an empty
  // expected value. HTTP header normalisation already strips the trailing
  // space so it isn't reachable in practice — the guard makes that safety
  // explicit instead of dependent on it.
  if (expectedToken) {
    const auth = request.headers.get("authorization");
    if (auth && secretEquals(auth, `Bearer ${expectedToken}`)) return null;
  }

  return unauthorized();
}

/**
 * Setup routes require the operator's per-boot code before a password exists,
 * and normal authentication after configuration.
 */
export async function requireAuthIfConfigured(request) {
  if (!isConfigured()) return requireSetupCode(request);
  return requireAuthJWT(request);
}

function normalizeSetupCode(value) {
  return typeof value === 'string' ? value.trim().replace(/[-\s]/g, '').toUpperCase() : '';
}

/** Only called while unconfigured. process.env shares the fallback across route bundles. */
function requireSetupCode(request) {
  if (!process.env.REV4A_SETUP_CODE) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(randomBytes(16), (byte) => alphabet[byte & 31]).join('');
    process.env.REV4A_SETUP_CODE = code.match(/.{4}/g).join('-');
    console.log(`[SETUP] ${process.env.REV4A_SETUP_CODE} — open the dashboard and enter this code`);
  }
  const supplied = normalizeSetupCode(request.headers.get('x-rev4a-setup-code'));
  if (secretEquals(supplied, normalizeSetupCode(process.env.REV4A_SETUP_CODE))) return null;
  return NextResponse.json({
    error: 'Setup code required: it is printed in the terminal (or the journal) where rev4a serve runs',
  }, { status: 403 });
}

/**
 * Compare a supplied secret with the expected one in constant time. Both are hashed to
 * a fixed length first, so neither the content nor the length of the expected value
 * leaks through how long the comparison takes. (The provider gateway's own check in
 * app/api/provider/auth.ts compares the raw bytes after a length guard instead.)
 */
export function secretEquals(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string" || !expected) return false;
  const digest = (value) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}
