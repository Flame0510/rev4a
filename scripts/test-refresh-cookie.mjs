#!/usr/bin/env node
/** SEC-16: POST /api/auth/refresh-cookie re-sets the same JWT as Secure + Strict, only for an https Origin. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as jose from 'jose';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const next = require('next/server');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, mocks, env) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const context = {
    exports: {}, URL, Date, Math, process: { env },
    require: (id) => { if (Object.hasOwn(mocks, id)) return mocks[id]; throw new Error(`Unexpected dependency: ${id}`); },
  };
  vm.runInNewContext(source, context, { filename: file });
  return context.exports;
}

const env = { NODE_ENV: 'production', REV4A_FORCE_INSECURE_COOKIE: '1' };
const cookieLib = load('lib/session-cookie.ts', {}, env);
let authed = true;
const route = load('app/api/auth/refresh-cookie/route.ts', {
  'next/server': next,
  jose,
  '@/lib/rev4a-auth': { requireAuthJWT: async () => authed ? null : next.NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) },
  '@/lib/session-cookie': cookieLib,
}, env);

const secret = new TextEncoder().encode('fixture-jwt-secret'); // secret-ok: local test fixture
const sign = (exp) => new jose.SignJWT({ role: 'admin', pwf: 'x' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(exp).sign(secret);
const post = (token, origin, extra = {}) => route.POST(new next.NextRequest('http://rev4a.example/api/auth/refresh-cookie', {
  method: 'POST',
  headers: { ...(token ? { cookie: `rev4a_token=${token}` } : {}), ...(origin ? { origin } : {}), ...extra },
}));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok   ${name}`); }

await test('401 without a session, nothing is set', async () => {
  authed = false;
  const res = await post(undefined, 'https://rev4a.example');
  assert.equal(res.status, 401);
  assert.equal(res.cookies.get('rev4a_token'), undefined);
  authed = true;
});

await test('204 and no cookie on a plain-HTTP, missing, null or unusable Origin', async () => {
  const token = await sign('7d');
  for (const origin of ['http://203.0.113.5:3740', undefined, 'null', 'garbage', 'https://u:p@h', 'https://h/path']) {
    const res = await post(token, origin);
    assert.equal(res.status, 204, String(origin));
    assert.equal(res.cookies.get('rev4a_token'), undefined, String(origin));
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

await test('https Origin re-sets the same token as Secure + Strict, maxAge never past exp', async () => {
  const token = await sign('2d');
  const exp = jose.decodeJwt(token).exp;
  const res = await post(token, 'https://rev4a.example');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const cookie = res.cookies.get('rev4a_token');
  assert.equal(cookie.value, token);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, 'strict');
  assert.equal(cookie.path, '/');
  const left = exp - Math.floor(Date.now() / 1000);
  assert.ok(cookie.maxAge <= left && cookie.maxAge >= left - 5, `${cookie.maxAge} vs ${left}`);
  assert.ok(cookie.maxAge <= 2 * 86400);
});

await test('an expired or exp-less token is left alone', async () => {
  const noExp = await new jose.SignJWT({ role: 'admin' }).setProtectedHeader({ alg: 'HS256' }).sign(secret);
  const res = await post(noExp, 'https://rev4a.example');
  assert.equal(res.status, 204);
  assert.equal(res.cookies.get('rev4a_token'), undefined);
  const past = await new jose.SignJWT({ role: 'admin' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(secret);
  assert.equal((await post(past, 'https://rev4a.example')).cookies.get('rev4a_token'), undefined);
});

await test('a request with Authorization never copies the cookie (it may be unverified)', async () => {
  const token = await sign('2d');
  const res = await post(token, 'https://rev4a.example', { authorization: 'Bearer fixture-api-token' });
  assert.equal(res.status, 204);
  assert.equal(res.cookies.get('rev4a_token'), undefined);
});

await test('maxAge is capped at 7 days', async () => {
  const token = await sign('3650d');
  const cookie = (await post(token, 'https://rev4a.example')).cookies.get('rev4a_token');
  assert.equal(cookie.maxAge, 7 * 86400);
});

console.log(`\n${passed} passed`);
