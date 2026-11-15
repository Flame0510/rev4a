#!/usr/bin/env node
/** SEC-16: the cookie flags follow the browser's own Origin scheme; the retired flag is never read. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = ts.transpileModule(fs.readFileSync(path.join(root, 'lib/session-cookie.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function helper(env) {
  const context = { exports: {}, URL, process: { env } };
  vm.runInNewContext(source, context, { filename: 'lib/session-cookie.ts' });
  return context.exports;
}
const req = (origin, extra = {}) => ({
  headers: new Headers({ ...(origin === undefined ? {} : { origin }), ...extra }),
});

const origins = [
  ['https://rev4a.example', 'https'],
  ['https://203.0.113.5:3740', 'https'],
  ['http://203.0.113.5:3740', 'http'],
  ['http://localhost:3740', 'http'],
  [undefined, 'unknown'],
  ['null', 'unknown'],
  ['garbage', 'unknown'],
  ['', 'unknown'],
  ['https://u:p@h', 'unknown'],
  ['http://u:p@h', 'unknown'],
  ['https://h/path', 'unknown'],
  ['http://h/path', 'unknown'],
  ['https://h?x=1', 'unknown'],
  ['ftp://h', 'unknown'],
];
let passed = 0;
for (const nodeEnv of ['production', 'development']) {
  for (const flag of [undefined, '1', 'true']) {
    const env = { NODE_ENV: nodeEnv, ...(flag === undefined ? {} : { REV4A_FORCE_INSECURE_COOKIE: flag }) };
    const { sessionCookieOptions } = helper(env);
    for (const [origin, kind] of origins) {
      const o = sessionCookieOptions(req(origin), { maxAge: 123 });
      const plain = nodeEnv === 'development' || kind === 'http';
      const label = `${nodeEnv} flag=${flag} origin=${origin}`;
      assert.equal(o.secure, !plain, label);
      assert.equal(o.sameSite, plain ? 'lax' : 'strict', label);
      assert.deepEqual([o.httpOnly, o.path, o.maxAge], [true, '/', 123], label);
      passed++;
    }
  }
}
console.log(`ok   ${passed} origin x flag x NODE_ENV cases`);

// Forwarded headers and the request URL never decide.
const { sessionCookieOptions } = helper({ NODE_ENV: 'production' });
const spoof = { headers: new Headers({ 'x-forwarded-proto': 'http', origin: 'https://h' }), url: 'http://h/api/auth/login' };
assert.equal(sessionCookieOptions(spoof, { maxAge: 1 }).secure, true);
const spoof2 = { headers: new Headers({ 'x-forwarded-proto': 'https' }), url: 'https://h/api/auth/login' };
assert.equal(sessionCookieOptions(spoof2, { maxAge: 1 }).sameSite, 'strict');
const spoof3 = { headers: new Headers({ 'x-forwarded-proto': 'https', origin: 'http://h' }), url: 'https://h/' };
assert.equal(sessionCookieOptions(spoof3, { maxAge: 1 }).secure, false);
console.log('ok   X-Forwarded-Proto and the request URL are ignored');

// No file under app/ or lib/ reads the retired flag any more.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const reads = /env(?:\.|\[['"])REV4A_FORCE_INSECURE_COOKIE/;
for (const dir of ['app', 'lib', 'bin']) {
  if (!fs.existsSync(path.join(root, dir))) continue;
  for (const file of walk(path.join(root, dir))) {
    assert.ok(!reads.test(fs.readFileSync(file, 'utf8')), `${file} still reads the retired flag`);
  }
}
for (const file of ['server.js', 'daemon.js', 'proxy.ts']) {
  const p = path.join(root, file);
  if (fs.existsSync(p)) assert.ok(!reads.test(fs.readFileSync(p, 'utf8')), file);
}
console.log('ok   the retired flag is read nowhere in app/, lib/, bin/, server.js, daemon.js, proxy.ts');
