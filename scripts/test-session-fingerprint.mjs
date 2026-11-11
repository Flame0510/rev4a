#!/usr/bin/env node
/** SEC-21: real signed JWTs and route code, isolated env/files, no server or sockets. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import * as jose from 'jose';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const next = require('next/server');
const fingerprint = require('../lib/session-fingerprint.js');
const { passwordFingerprint, fingerprintEquals } = fingerprint;
const ENV_FILE = '/fixture/.env';
const originalPassword = 'fixture-password'; // secret-ok: local test fixture
const changedPassword = 'changed-fixture-password'; // secret-ok: local test fixture
const jwtSecret = 'fixture-jwt-secret'; // secret-ok: local test fixture
let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok   ${name}`);
}

function load(file, dependencies, globals) {
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, TextEncoder, URL,
    require: (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected import ${id} in ${file}`);
      return dependencies[id];
    },
    ...globals,
  }, { filename: file });
  return module.exports;
}

function harness(env = { REV4A_PASSWORD: originalPassword, REV4A_JWT_SECRET: jwtSecret }, content = '') {
  const files = new Map([[ENV_FILE, content]]);
  const mockFs = {
    existsSync: (file) => files.has(file),
    readFileSync: (file) => {
      assert.equal(file, ENV_FILE, 'auth must only read the fixture .env');
      if (!files.has(file)) throw new Error('Fixture file missing');
      return files.get(file);
    },
  };
  const globals = { process: { env }, console: { log() {}, error() {} } };
  const dependencies = {
    'next/server': next, jose, fs: mockFs, crypto: require('node:crypto'),
    './session-fingerprint.js': fingerprint,
    '@/lib/rev4a-paths': { ENV_FILE, REV4A_DATA: '/fixture' },
    '@/lib/env-file': require('../lib/env-file.js'),
    '@/lib/login-throttle': require('../lib/login-throttle.js'),
    '@/lib/client-address': require('../lib/client-address.js'),
    '@/lib/update-state': { currentUpdate: () => null }, path,
  };
  const auth = load('lib/rev4a-auth.js', dependencies, globals);
  dependencies['@/lib/rev4a-auth'] = auth;
  const { POST } = load('app/api/auth/login/route.ts', dependencies, globals);
  const { GET: check } = load('app/api/auth/check/route.ts', dependencies, globals);
  const { proxy } = load('proxy.ts', dependencies, globals);

  // Extract only authentication functions. Never execute server.js startup, Next or a listener.
  const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.js', serverSource, ts.ScriptTarget.Latest, true);
  const names = ['authEnvValue', 'jwtSecret', 'cookieValue', 'authorised'];
  const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length, 'extract every terminal auth function');
  const context = {
    ...globals, ...fingerprint, fs: mockFs, path, DATA_DIR: '/fixture', readEnvValue: require('../lib/env-file.js').readEnvValue,
    TextEncoder, jwtVerify: jose.jwtVerify,
  };
  vm.runInNewContext(functions.map((node) => node.getText(ast)).join('\n'), context, { filename: 'server-auth.js' });

  const request = (token, headers = {}) => new next.NextRequest('https://rev4a.example/agents', {
    headers: { ...(token === undefined ? {} : { cookie: `rev4a_token=${encodeURIComponent(token)}` }), ...headers },
  });
  return {
    env, files, auth, authorised: context.authorised,
    async login(password) {
      const response = await POST(new next.NextRequest('https://rev4a.example/api/auth/login', {
        method: 'POST', body: JSON.stringify({ password }), headers: { 'content-type': 'application/json' },
      }));
      return { response, token: response.cookies.get('rev4a_token')?.value };
    },
    async checkAll(token, accepted, label = '') {
      const api = await auth.requireAuthJWT(request(token));
      assert.equal(api?.status ?? 200, accepted ? 200 : 401, `${label}: API`);
      if (!accepted) assert.deepEqual(await api.json(), { error: 'Unauthorized' });
      const checked = await check(request(token));
      assert.equal(checked.status, accepted ? 200 : 401, `${label}: auth/check`);
      assert.deepEqual(await checked.json(), { authenticated: accepted });
      const page = await proxy(request(token));
      assert.equal(page.status, accepted ? 200 : 307, `${label}: page`);
      if (!accepted) assert.equal(page.headers.get('location'), 'https://rev4a.example/login');
      else assert.equal(page.headers.get('x-middleware-next'), '1');
      assert.equal(await context.authorised({ headers: { cookie: request(token).headers.get('cookie') } }), accepted,
        `${label}: terminal upgrade`);
    },
    api: (token, authorization) => auth.requireAuthJWT(request(token, { authorization })),
    check: (token, authorization) => check(request(token, { authorization })),
  };
}

async function sign(payload, secret = jwtSecret, expiry = '7d') {
  return new jose.SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
    .setExpirationTime(expiry).sign(new TextEncoder().encode(secret));
}

await test('fingerprint has a stable labelled HMAC vector, 22 base64url characters and depends on both inputs', () => {
  const value = passwordFingerprint(originalPassword, jwtSecret);
  assert.equal(value, 'veH--1Mhqm8y4uDUJdwFZ_');
  assert.match(value, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(value, originalPassword);
  assert.notEqual(value, passwordFingerprint(changedPassword, jwtSecret));
  assert.notEqual(value, passwordFingerprint(originalPassword, 'other-fixture-key'));
  assert.notEqual(passwordFingerprint(' p ', jwtSecret), passwordFingerprint('p', jwtSecret));
  assert.equal(fingerprintEquals(value, value), true);
  for (const invalid of [undefined, null, 1, true, {}, [], '', value.slice(1), `${value}x`, 'é'.repeat(22), `x${value.slice(1)}`]) {
    assert.equal(fingerprintEquals(invalid, value), false);
  }
  assert.equal(fingerprintEquals('', ''), false);
  assert.equal(fingerprintEquals(value, null), false);
});

await test('current login is accepted by API, auth/check, pages and terminal; lifetime and cookie flags stay unchanged', async () => {
  for (const [env, secure] of [
    [{ NODE_ENV: 'production' }, true],
    [{ NODE_ENV: 'production', REV4A_FORCE_INSECURE_COOKIE: '1' }, false],
    [{ NODE_ENV: 'development' }, false],
  ]) {
    const h = harness({ ...env, REV4A_PASSWORD: originalPassword, REV4A_JWT_SECRET: jwtSecret });
    const { response, token } = await h.login(originalPassword);
    assert.equal(response.status, 200);
    const { payload, protectedHeader } = await jose.jwtVerify(token, new TextEncoder().encode(jwtSecret));
    assert.equal(protectedHeader.alg, 'HS256');
    assert.equal(payload.role, 'admin');
    assert.equal(payload.pwf, passwordFingerprint(originalPassword, jwtSecret));
    assert.equal(payload.exp - payload.iat, 7 * 24 * 60 * 60);
    const cookie = response.cookies.get('rev4a_token');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, secure);
    assert.equal(cookie.sameSite, secure ? 'strict' : 'lax');
    assert.equal(cookie.maxAge, 7 * 24 * 60 * 60);
    assert.equal(cookie.path, '/');
    await h.checkAll(token, true);
    assert.equal((await h.login('wrong-fixture-password')).response.status, 401);
  }
});

await test('Config file edit takes effect when the effective environment changes; new login then succeeds', async () => {
  const h = harness();
  const { token: oldToken } = await h.login(originalPassword);
  h.files.set(ENV_FILE, `REV4A_PASSWORD=${changedPassword}\nREV4A_JWT_SECRET=${jwtSecret}\n`);
  await h.checkAll(oldToken, true, 'pending restart');
  h.env.REV4A_PASSWORD = changedPassword;
  await h.checkAll(oldToken, false, 'password applied');
  assert.equal((await h.login(originalPassword)).response.status, 401);
  const { response, token } = await h.login(changedPassword);
  assert.equal(response.status, 200);
  await h.checkAll(token, true, 'new login');
});

await test('.env fallback, trimming and empty environment use the same current password in all verifiers', async () => {
  const h = harness({ REV4A_PASSWORD: '', REV4A_JWT_SECRET: '' },
    `REV4A_PASSWORD=  ${originalPassword}  \nREV4A_JWT_SECRET=  ${jwtSecret}  \n`);
  const { token } = await h.login(originalPassword);
  await h.checkAll(token, true);
  h.files.set(ENV_FILE, `REV4A_PASSWORD=${changedPassword}\nREV4A_JWT_SECRET=${jwtSecret}\n`);
  await h.checkAll(token, false);
  const replacement = await h.login(changedPassword);
  assert.equal(replacement.response.status, 200);
  await h.checkAll(replacement.token, true);
});

await test('legacy, changed or malformed claims, invalid signatures, expired and missing cookies are refused everywhere', async () => {
  const h = harness();
  for (const pwf of [undefined, '', null, 1, {}, [], 'tampered-fixture-value', passwordFingerprint(changedPassword, jwtSecret)]) {
    await h.checkAll(await sign({ role: 'admin', ...(pwf === undefined ? {} : { pwf }) }), false, 'invalid pwf');
  }
  const payload = { role: 'admin', pwf: passwordFingerprint(originalPassword, jwtSecret) };
  await h.checkAll(await sign(payload, 'wrong-fixture-signing-key'), false, 'wrong signature');
  await h.checkAll(await sign(payload, jwtSecret, '-1s'), false, 'expired');
  await h.checkAll('not-a-jwt', false);
  await h.checkAll(undefined, false);
  assert.equal(await h.authorised({ headers: { cookie: 'rev4a_token=%ZZ' } }), false);
});

await test('empty, missing and unreadable password configuration cannot create or authenticate a cookie session', async () => {
  const oldToken = await sign({ role: 'admin', pwf: passwordFingerprint(originalPassword, jwtSecret) });
  const emptyPasswordToken = await sign({ role: 'admin', pwf: passwordFingerprint('', jwtSecret) });
  for (const content of ['', 'REV4A_PASSWORD=\n', 'REV4A_PASSWORD=   \n', undefined]) {
    const h = harness({ REV4A_JWT_SECRET: jwtSecret }, content);
    if (content === undefined) h.files.delete(ENV_FILE);
    assert.equal((await h.login(originalPassword)).response.status, 401);
    await h.checkAll(oldToken, false);
    await h.checkAll(emptyPasswordToken, false);
    // Simulate a read failure without touching the operator's files.
    h.files.get = () => { throw new Error('Fixture read denied'); };
    await h.checkAll(oldToken, false);
  }
});

await test('missing JWT secret fails closed; rotation also rejects existing cookies', async () => {
  const h = harness();
  const { token } = await h.login(originalPassword);
  h.env.REV4A_JWT_SECRET = '';
  assert.equal((await h.login(originalPassword)).response.status, 401);
  await h.checkAll(token, false);
  h.env.REV4A_JWT_SECRET = 'replacement-fixture-signing-key'; // secret-ok: local test fixture
  await h.checkAll(token, false);
  const replacement = await h.login(originalPassword);
  await h.checkAll(replacement.token, true);
});

await test('Bearer API authentication remains independent; auth/check and terminal stay cookie-only', async () => {
  const h = harness();
  const { token } = await h.login(originalPassword);
  h.env.REV4A_TOKEN = 'fixture-api-bearer'; // secret-ok: local test fixture
  for (const password of [originalPassword, changedPassword, '']) {
    h.env.REV4A_PASSWORD = password;
    for (const cookie of [undefined, token, 'invalid-cookie']) {
      assert.equal(await h.api(cookie, 'Bearer fixture-api-bearer'), null);
      const checked = await h.check(cookie, 'Bearer fixture-api-bearer');
      const accepted = cookie === token && password === originalPassword;
      assert.equal(checked.status, accepted ? 200 : 401);
      assert.deepEqual(await checked.json(), { authenticated: accepted });
    }
    assert.equal((await h.api(undefined, 'Bearer wrong-fixture-bearer')).status, 401);
    assert.equal(await h.authorised({ headers: { authorization: 'Bearer fixture-api-bearer' } }), false);
  }
  delete h.env.REV4A_TOKEN;
  assert.equal((await h.api(undefined, 'Bearer ')).status, 401);
});

console.log(`\nEXECUTED: test-session-fingerprint.mjs — ${passed} SEC-21 test groups passed`);
