#!/usr/bin/env node
/** Config inspection redacts secrets before the response, including all failure paths. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function load(file, deps) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    assert.ok(name in deps, `unexpected dependency ${name}`); return deps[name];
  } });
  return module.exports;
}
const redactor = load('lib/redact-secret.ts', { './update-state.js': require('../lib/update-state.js') });
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
const fixture = {
  gateway: { port: 3000, auth: { mode: 'token', token: 'fixture-gateway-value', allowTailscale: false } }, // secret-ok: synthetic fixture
  channels: { telegram: { enabled: true, botToken: 'fixture-telegram-value', accounts: [{ botToken: 'fixture-account-value', name: 'Visible account' }] } }, // secret-ok: synthetic fixture
  models: { providers: { rev4a: { apiKey: 'fixture-provider-value', headers: { 'x-rev4a-agent': 'fixture-header-value', 'x-visible': 'keep' }, baseUrl: 'http://host/api/provider/v1', models: [{ id: 'visible-model', contextWindow: 100000 }] } } }, // secret-ok: synthetic fixture
  skills: { entries: { demo: { enabled: true, apiKey: 'fixture-skill-value', env: { UNFAMILIAR: 'fixture-env-value', COUNT: 12 }, config: { path: '/visible/path' } } } }, // secret-ok: synthetic fixture
  extensions: [{ futureClientSecret: 'x', private_key: { nested: 'fixture-private-value' }, PASSWORD: 123, FOO_PAT: false, refresh: null, declarationKey: 'visible-declaration' }],
};
await test('Gateway and Telegram tokens, provider key/header and every skill env value are masked', () => {
  const original = JSON.stringify(fixture);
  const result = plain(redactor.redactConfigSecrets(fixture));
  assert.equal(result.gateway.auth.token, '***'); assert.equal(result.channels.telegram.botToken, '***');
  assert.equal(result.channels.telegram.accounts[0].botToken, '***');
  assert.equal(result.models.providers.rev4a.apiKey, '***'); assert.equal(result.models.providers.rev4a.headers['x-rev4a-agent'], '***');
  assert.equal(result.skills.entries.demo.apiKey, '***'); assert.deepEqual(result.skills.entries.demo.env, { UNFAMILIAR: '***', COUNT: '***' });
  assert.equal(JSON.stringify(fixture), original, 'redaction must not mutate the source');
  assert.doesNotMatch(JSON.stringify(result), /fixture-.*?-value/);
});
await test('unknown secret-named keys are masked for short, numeric, null and object values', () => {
  const result = plain(redactor.redactConfigSecrets(fixture));
  assert.deepEqual(result.extensions[0], { futureClientSecret: '***', private_key: '***', PASSWORD: '***', FOO_PAT: '***', refresh: '***', declarationKey: '***' });
});
await test('non-secret config structure, model lists, booleans and auth mode stay visible', () => {
  const result = plain(redactor.redactConfigSecrets(fixture));
  assert.equal(result.gateway.auth.mode, 'token'); assert.equal(result.gateway.auth.allowTailscale, false); assert.equal(result.gateway.port, 3000);
  assert.equal(result.channels.telegram.enabled, true); assert.equal(result.channels.telegram.accounts[0].name, 'Visible account');
  assert.equal(result.models.providers.rev4a.headers['x-visible'], '***');
  assert.deepEqual(result.models.providers.rev4a.models, fixture.models.providers.rev4a.models);
  assert.deepEqual(result.skills.entries.demo.config, { path: '/visible/path' });
  assert.equal(redactor.redactConfigSecrets(null), null);
});
await test('credential locations mask opaque names, serialized credentials, and primitive array members', () => {
  const fixtures = [
    { models: { providers: { example: { apiKey: ['fixture-key-value'], headers: { 'X-Subscription': ['fixture-header-value', { OPAQUE: 'fixture-nested-value' }] } } } } }, // secret-ok: synthetic fixture
    { channels: { googlechat: { serviceAccount: '{"private_key":"fixture-service-value"}' } } }, // secret-ok: synthetic fixture
    { channels: { custom: { botToken: ['fixture-bot-value'], accounts: [{ botToken: 'fixture-account-value', token: ['fixture-token-value'], secret: { OPAQUE: 'fixture-secret-value' } }] } } }, // secret-ok: synthetic fixture
    { channels: { custom: { accounts: { primary: { botToken: 'fixture-map-value', token: 'fixture-token-value', secret: 'fixture-secret-value' } } } } }, // secret-ok: synthetic fixture
    { plugins: { entries: { acpx: { config: { mcpServers: { example: { env: { OPAQUE: 'fixture-plugin-value', ARRAY: ['fixture-array-value', { opaque: 'fixture-deep-value' }] } } } } } } } }, // secret-ok: synthetic fixture
    { skills: { entries: { demo: { apiKey: ['fixture-skill-value'], env: ['fixture-array-value', 1, false, null, ['fixture-nested-value']] } } } }, // secret-ok: synthetic fixture
    { env: { OPAQUE: 'fixture-root-value' }, nested: { env: ['fixture-env-value'] } }, // secret-ok: synthetic fixture
    { gateway: { auth: { token: ['fixture-token-value'], password: 'fixture-password-value', opaque: ['fixture-opaque-value'] } } }, // secret-ok: synthetic fixture
    { gateway: { auth: { mode: ['fixture-mode-value'], allowTailscale: ['fixture-tailscale-value'] } } }, // secret-ok: synthetic fixture
    { credentials: { profiles: [{ OPAQUE: 'fixture-credential-value' }] }, authProfiles: ['fixture-profile-value'], 'auth-profiles': { arbitrary: 'fixture-profile-value' }, auth: { profiles: ['fixture-auth-value'] } }, // secret-ok: synthetic fixture
  ];
  for (const fixture of fixtures) {
    const before = JSON.stringify(fixture);
    assert.doesNotMatch(JSON.stringify(redactor.redactConfigSecrets(fixture)), /fixture-[a-z-]+-value/, before);
    assert.equal(JSON.stringify(fixture), before);
  }
  const result = plain(redactor.redactConfigSecrets({ env: ['secret', 1, false, null, ['nested']] })); // secret-ok: synthetic fixture
  assert.deepEqual(result.env, ['***', '***', '***', '***', ['***']]);
});
let raw = JSON.stringify(fixture), denied = null, reads = 0;
const routeDeps = {
  'next/server': { NextResponse: { json: (body, opts) => ({ body: plain(body), status: opts?.status ?? 200 }) } },
  '@/lib/rev4a-auth': { requireAuthJWT: async () => denied },
  '@/lib/docker-exec': { dockerExec: async (name, args) => { reads++; assert.equal(name, 'fixture'); assert.deepEqual(plain(args), ['cat', '/root/.openclaw/openclaw.json']); if (raw instanceof Error) throw raw; return raw; } },
  '@/lib/redact-secret': redactor,
};
const { GET } = load('app/api/agents/config-json/route.ts', routeDeps);
const { GET: realGET } = load('app/api/agents/config-json/route.ts', { ...routeDeps, 'next/server': require('next/server') });
const request = name => ({ nextUrl: new URL('http://localhost/api/agents/config-json' + (name ? '?name=' + encodeURIComponent(name) : '')) });
await test('actual route only returns the redacted object', async () => {
  const result = await GET(request('fixture'));
  assert.equal(result.status, 200); assert.equal(result.body.config.skills.entries.demo.env.UNFAMILIAR, '***');
  assert.doesNotMatch(JSON.stringify(result), /fixture-.*?-value/);
});
// Every location from checker B, tested through the actual GET handler as well as
// the shared redactor. Opaque names and primitive array members must not escape.
const probes = [
  'channels.buzz.authTag',
  'channels.buzz.accounts.primary.authTag',
  'channels.buzz.accounts.0.authTag',
  'models.providers.example.request.headers.OPAQUE',
  'models.providers.example.request.tls.ca',
  'models.providers.example.request.tls.cert',
  'models.providers.example.request.proxy.tls.ca',
  'models.providers.example.request.proxy.tls.cert',
  'plugins.entries.codex.config.appServer.headers.OPAQUE',
  'plugins.entries.comfy.config.headers.OPAQUE',
  'plugins.entries.google.config.webSearch.headers.OPAQUE',
];
function atPath(path, value) {
  return path.split('.').reduceRight((child, key) => key === '0' ? [child] : { [key]: child }, value);
}
for (const path of probes) await test(`checker credential probe: ${path}`, async () => {
  const value = ['fixture-probe-value', 1, false, null, { opaque: 'fixture-deep-value', nested: ['fixture-array-value'] }];
  const input = atPath(path, value);
  const before = JSON.stringify(input);
  const expected = atPath(path, path.endsWith('authTag') ? '***' : ['***', '***', '***', '***', { opaque: '***', nested: ['***'] }]);
  assert.deepEqual(plain(redactor.redactConfigSecrets(input)), expected);
  assert.equal(JSON.stringify(input), before);
  raw = before;
  const result = await GET(request('fixture'));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.config, expected);
  assert.doesNotMatch(JSON.stringify(result), /fixture-[a-z-]+-value/);
  const realResponse = await realGET(request('fixture'));
  assert.equal(realResponse.status, 200);
  assert.deepEqual((await realResponse.json()).config, expected);
});
for (const key of ['authTag', 'AuthTag', 'AUTH_TAG', 'auth_tag', 'auth-tag', 'auth.tag', 'AUTHTag', 'AUTHTAG', 'authtag', 'authCode', 'authHeader', 'authenticationTag']) {
  await test(`shared key classifier and GET mask ${key}`, async () => {
    assert.equal(require('../lib/update-state.js').isSecretName(key), true);
    assert.doesNotMatch(require('../lib/update-state.js').redact(`${key}=fixture-name-value`), /fixture-name-value/);
    raw = JSON.stringify({ future: { [key]: ['fixture-name-value', { opaque: 'fixture-deep-value' }] } });
    const result = await GET(request('fixture'));
    assert.equal(result.status, 200); assert.equal(result.body.config.future[key], '***');
  });
}
await test('malformed JSON and transport failures never return raw config, stdout or stderr', async () => {
  for (const value of ['{"botToken":"fixture-malformed-value",', new Error('fixture-error-value')]) {
    raw = value; const result = await GET(request('fixture'));
    assert.equal(result.status, 500); assert.equal(result.body.content, undefined); assert.doesNotMatch(JSON.stringify(result), /fixture-.*?-value/);
  }
  raw = ''; assert.equal((await GET(request('fixture'))).status, 404);
  raw = new Error('cat: /root/.openclaw/openclaw.json: No such file or directory');
  assert.equal((await GET(request('fixture'))).status, 404);
});
await test('non-object JSON roots never echo config content', async () => {
  for (const value of ['fixture-root-value', ['fixture-array-value'], null, true, 42]) {
    raw = JSON.stringify(value);
    const result = await GET(request('fixture'));
    assert.equal(result.status, 500);
    assert.equal(result.body.config, undefined);
    assert.doesNotMatch(JSON.stringify(result), /fixture-[a-z-]+-value/);
  }
});
await test('authorization and invalid names are refused before reading the container', async () => {
  const before = reads; denied = { status: 401 }; assert.equal((await GET(request('fixture'))).status, 401); denied = null;
  assert.equal((await GET(request('bad;name'))).status, 400); assert.equal((await GET(request())).status, 400); assert.equal(reads, before);
});
console.log(`\n${passed} passed`);
