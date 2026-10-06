#!/usr/bin/env node
'use strict';

/**
 * add-auth-to-routes.cjs
 *
 * Injects `requireAuthJWT` into every unprotected API route handler.
 * Strategy:
 *  1. Insert import line after the last existing import
 *  2. Add auth check as first statement in every exported HTTP handler
 *  3. Handle _req/_request/req → rename to request (standardize)
 *  4. Handle handlers with no request param (add one)
 *  5. Handle .ts and .js files
 *
 * Whitelist (public routes, no auth):
 *   app/api/auth/*, app/api/setup/*, app/api/wizard/*, app/api/provider/v1/*
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT, 'app', 'api');

const WHITELIST = [
  'app/api/auth/',
  'app/api/setup/',
  'app/api/wizard/',
  'app/api/provider/v1/',
];

const ALREADY_PROTECTED = new Set([
  'app/api/skills/promote/route.js',
  'app/api/skills/save/route.js',
  'app/api/skills/delete/route.js',
]);

const IMPORT_LINE = `import { requireAuthJWT } from '@/lib/rev4a-auth';`;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name === 'route.ts' || e.name === 'route.js') out.push(p);
  }
  return out;
}

/** Check if this path is whitelisted (public) */
function isWhitelisted(absPath) {
  const rel = path.relative(ROOT, absPath);
  return WHITELIST.some(w => rel.startsWith(w));
}

/** Check if this path already has auth protection */
function isProtected(absPath) {
  const rel = path.relative(ROOT, absPath);
  return ALREADY_PROTECTED.has(rel);
}

/**
 * Rewrite a single file to add requireAuthJWT to every exported handler.
 * Returns { status, reason, modified }.
 */
function processFile(filePath) {
  let src = fs.readFileSync(filePath, 'utf-8');
  const isJs = filePath.endsWith('.js');

  if (src.includes('requireAuthJWT')) {
    return { status: 'skip', reason: 'already has requireAuthJWT' };
  }

  // Check if any HTTP handler exists
  const hasMethod = METHODS.some(m => new RegExp(
    `export\\s+(async\\s+)?function\\s+${m}\\s*\\(`
  ).test(src));
  if (!hasMethod) {
    return { status: 'skip', reason: 'no HTTP handler' };
  }

  let modified = false;

  // ── Step 1: Add import ────────────────────────────────────────
  if (!src.includes(IMPORT_LINE)) {
    const lines = src.split('\n');
    let lastImport = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith('import ') || t === "'use strict';" || t === '"use strict";') {
        lastImport = i;
      }
    }
    if (lastImport >= 0) {
      lines.splice(lastImport + 1, 0, IMPORT_LINE);
    }
    // else: no imports? prepend after block comment if any
    src = lines.join('\n');
    modified = true;
  }

  // ── Step 2: Standardize handler signatures ───────────────────
  // Replace _req, _request, req (not "request") with "request" as first param
  for (const m of METHODS) {
    // "_req: Type" or "_req)"  →  "request: Type" / "request)"
    src = src.replace(
      new RegExp(`(function\\s+${m}\\s*\\()\\s*_req\\b`, 'g'),
      '$1request'
    );
    // "_request: Type" or "_request)"  →  "request: Type" / "request)"
    src = src.replace(
      new RegExp(`(function\\s+${m}\\s*\\()\\s*_request\\b`, 'g'),
      '$1request'
    );
    // "req:" (standalone, not part of "request:") → "request:"
    src = src.replace(
      new RegExp(`(function\\s+${m}\\s*\\()\\s*req\\b(?!uest)`, 'g'),
      '$1request'
    );
    // "req)" (standalone) → "request)"
    // (handled by the line below with the function body regex)
  }

  // Also fix body references: req.url → request.url, req.json → request.json
  // Only in protected files that had _req or req renamed
  src = src.replace(/\breq\.url\b/g, 'request.url');
  src = src.replace(/\breq\.json\b/g, 'request.json');

  // ── Step 3: Ensure every handler has "request" param ─────────
  for (const m of METHODS) {
    // Match: export async function METHOD() {  (no params)
    const noParams = new RegExp(
      `(export\\s+(async\\s+)?function\\s+${m})\\s*\\(\\s*\\)`,
      'g'
    );
    src = src.replace(noParams, `$1(_req: NextRequest) { const request = _req;`);
    modified = modified || noParams.test(src);
  }

  // ── Step 4: Inject auth check ─────────────────────────────────
  for (const m of METHODS) {
    // Match handler signature up to the opening brace + newline
    // Pattern: export async function METHOD(params...) { \n
    const pat = new RegExp(
      `(export\\s+(async\\s+)?function\\s+${m}\\s*\\([^)]*\\)[^\{]*\\{)\\n`,
      'g'
    );
    const auth = isJs
      ? '  const denied = await requireAuthJWT(request); if (denied) return denied;'
      : '  const denied = await requireAuthJWT(request); if (denied) return denied as any;';
    src = src.replace(pat, `$1\n${auth}\n`);
  }

  modified = true; // We injected auth
  fs.writeFileSync(filePath, src, 'utf-8');
  return { status: 'ok', reason: 'injected', modified };
}

// ── Main ────────────────────────────────────────────────────────
console.log('Step 1: Discover routes\n');
const all = walk(API_DIR);
console.log(`Total: ${all.length}\n`);

const targets = [];
for (const p of all) {
  const rel = path.relative(ROOT, p);
  if (isWhitelisted(p)) { console.log(`  [whitelist] ${rel}`); continue; }
  if (isProtected(p))   { console.log(`  [protected] ${rel}`); continue; }
  targets.push(p);
}

console.log(`\nStep 2: Inject auth into ${targets.length} routes\n`);

let ok = 0, skip = 0;
for (const p of targets) {
  const rel = path.relative(ROOT, p);
  const r = processFile(p);
  if (r.status === 'ok') { console.log(`  ✓ ${rel}`); ok++; }
  else { console.log(`  - ${rel} (${r.reason})`); skip++; }
}

console.log(`\nDone: ${ok} modified, ${skip} skipped`);
