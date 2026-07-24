import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import * as fs from "fs";
import * as path from "path";

function readEnvFile(key) {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return '';
    const content = fs.readFileSync(envPath, 'utf-8');
    const regex = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=(.*)$', 'm');
    const match = content.match(regex);
    if (match && match[1].trim()) return match[1].trim();
  } catch {}
  return '';
}

function getExpectedToken() {
  const token = readEnvFile('OLYMPUS_TOKEN');
  if (!token) console.warn('OLYMPUS_TOKEN is not set — auth will reject all requests');
  return token;
}

export function requireAuth(request) {
  const auth = request.headers.get("authorization");
  if (!auth || auth !== `Bearer ${getExpectedToken()}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function requireAuthJWT(request) {
  const privateCookie = request.cookies?.get?.("olympus_token")?.value;
  const secret = readEnvFile('OLYMPUS_JWT_SECRET');

  if (privateCookie && secret) {
    try {
      const key = new TextEncoder().encode(secret);
      await jwtVerify(privateCookie, key);
      return null;
    } catch {}
  }

  const auth = request.headers.get("authorization");
  const expectedToken = readEnvFile('OLYMPUS_TOKEN');
  if (auth === `Bearer ${expectedToken}`) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
