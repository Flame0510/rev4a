#!/usr/bin/env node
/** SEC-16: actual link resolution and route, with offline Docker/auth fixtures only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function load(file, mocks, extra = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = {
    exports: {}, URL, URLSearchParams, Date,
    require: (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      throw new Error(`Unexpected dependency: ${id}`);
    },
    ...extra,
  };
  vm.runInNewContext(source, context, { filename: file });
  return context.exports;
}

const token = 'fixture+/= %value'; // secret-ok: synthetic offline fixture
const bootstrap = 'fixture+/= %bootstrap';
const port = '4550';
const gateway = 'ws://127.0.0.1:3000/socket?mode=control&encoded=%2B';
const fragment = new URLSearchParams({ bootstrapToken: bootstrap, token, gatewayUrl: gateway, theme: 'dark mode' });
const browserUrl = `http://127.0.0.1:3000/prefix/control?lang=en&encoded=%2B#${fragment}`;

function devicesFixture(mode = 'one-time') {
  const calls = [];
  const devices = load('lib/agent-devices.ts', {
    '@/lib/docker-exec': {
      dockerExecNoFail: async () => mode === 'old-agent' ? '' : '{"version":"2026.9.9"}',
      dockerExec: async (_container, args) => {
        calls.push(args);
        if (args[0] === 'dashboard') {
          if (mode === 'failed-link') throw new Error('Fixture CLI failure');
          return JSON.stringify({ ok: true, browserUrl, browserBootstrapExpiresAtMs: 123456 });
        }
        assert.equal(args[0], 'sh');
        return token;
      },
    },
    '@/lib/docker-socket': { dockerFetch: async () => [{ Names: ['/fixture-agent'], State: 'running', Ports: [{ PrivatePort: 3000, PublicPort: Number(port) }] }] },
    '@/lib/container': { isValidAgentId: () => true },
    '@/lib/gateway-cli': { gatewayCliArgv: (args) => args },
  });
  return { devices, calls };
}

const cases = [
  ['localhost', '127.0.0.1', true],
  ['LOCALHOST', '127.0.0.1', true],
  ['localhost.', '127.0.0.1', true],
  ['LOCALHOST.', '127.0.0.1', true],
  ['127.0.0.1', 'localhost', true],
  ['127.1.2.3', 'localhost', true],
  ['127.0.0.0', 'localhost', true],
  ['127.255.255.255', 'localhost', true],
  ['::1', 'localhost', true],
  ['[::1]', 'localhost', true],
  ['192.168.1.10', '192.168.1.10', false],
  ['203.0.113.5', '203.0.113.5', false],
  ['rev4a.example.com', 'rev4a.example.com', false],
  ['localhost.example.com', 'localhost.example.com', false],
  ['127.999.1.1', '127.999.1.1', false],
  ['127.1.2.3.example.com', '127.1.2.3.example.com', false],
  ['2001:db8::1', '2001:db8::1', false],
];
const urlHost = (host) => host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok   ${name}`);
}

await test('pure helper maps only the specified loopback hosts', () => {
  const { devices, calls } = devicesFixture();
  for (const [input, host, isolated] of cases) {
    const result = devices.controlUiHostFor(input);
    assert.equal(result.host, host, input);
    assert.equal(result.isolated, isolated, input);
  }
  assert.equal(calls.length, 0);
});

for (const mode of ['one-time', 'old-agent', 'failed-link']) {
  await test(`${mode}: actual resolver preserves the link and maps the host exactly once`, async () => {
    const { devices } = devicesFixture(mode);
    for (const [input, host, isolated] of cases.filter(([input]) => input !== '127.999.1.1')) {
      const result = await devices.resolveControlUiUrl('fixture-agent', input, port);
      const actual = new URL(result.url);
      assert.equal(result.isolated, isolated, input);
      assert.equal(actual.hostname, urlHost(host), input);
      assert.equal(actual.port, port, input);
      assert.equal(actual.protocol, 'http:');
      if (mode === 'one-time') {
        assert.equal(result.kind, 'one-time');
        assert.equal(actual.pathname, '/prefix/control');
        assert.equal(actual.search, '?lang=en&encoded=%2B');
        const params = new URLSearchParams(actual.hash.slice(1));
        assert.equal(params.get('bootstrapToken'), bootstrap);
        assert.equal(params.get('token'), token);
        assert.equal(params.get('theme'), 'dark mode');
        assert.equal(params.size, fragment.size);
        const expectedWs = new URL(gateway);
        expectedWs.hostname = urlHost(host);
        expectedWs.port = port;
        assert.equal(params.get('gatewayUrl'), expectedWs.toString());
        const expectedParams = new URLSearchParams(fragment);
        expectedParams.set('gatewayUrl', expectedWs.toString());
        assert.equal(actual.hash, `#${expectedParams}`);
      } else {
        assert.equal(result.kind, 'token');
        assert.equal(result.url, `http://${urlHost(host)}:${port}/#token=${encodeURIComponent(token)}`);
      }
    }
  });
}

class Reply {
  constructor(body, options = {}) {
    this.body = body;
    this.status = options.status ?? 200;
    this.headers = options.headers ?? {};
  }
  static json(body, options = {}) {
    return new Reply(JSON.stringify(body), { status: options.status, headers: options.headers });
  }
}
const job = '8d10c9bf-231a-41af-a01f-bdbb2ff6a3f1';
const ids = load('lib/cron-ids.ts', {});
const navigation = load('lib/control-ui-navigation.ts', { './cron-ids': ids });
function routeFixture(options = {}) {
  const { mode = 'one-time', denied = null } = options;
  const warnings = [];
  const { devices, calls } = devicesFixture(mode);
  const route = load('app/api/agents/[id]/open-control-ui/route.ts', {
    'next/server': { NextResponse: Reply },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => denied },
    '@/lib/agent-readiness': { probeGateway: async () => { throw new Error('Unexpected probe'); } },
    '@/lib/gateway-state': {},
    '@/lib/docker-socket': { dockerFetch: async () => ({}) },
    '@/lib/agent-devices': devices,
    '@/lib/cron-ids': ids,
    '@/lib/control-ui-navigation': navigation,
  }, { process: { env: { REV4A_FORCE_INSECURE_COOKIE: '1' } }, console: { warn: (...args) => warnings.push(args) } });
  const open = (host = 'rev4a.example.com', protocol = 'http:', extraHeaders = {}, query = '') => route.GET({
    url: `${protocol}//${urlHost(host)}:3740/api/agents/fixture-agent/open-control-ui${query}`,
    headers: new Headers({ host: `${urlHost(host)}:3740`, ...extraHeaders }),
  }, { params: Promise.resolve({ id: 'fixture-agent' }) });
  return { open, warnings, calls };
}

await test('actual route uses both isolated link kinds without warning or redirect additions', async () => {
  for (const mode of ['one-time', 'old-agent']) {
    const f = routeFixture({ mode });
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      const result = await f.open(host);
      assert.equal(result.status, 302);
      const expected = await devicesFixture(mode).devices.resolveControlUiUrl('fixture-agent', host, port);
      assert.equal(result.headers.Location, expected.url);
      assert.equal(result.headers['Cache-Control'], 'no-store');
      assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
    }
    assert.deepEqual(f.warnings, []);
  }
});

await test('the retired REV4A_FORCE_INSECURE_COOKIE flag never makes the route log or change anything', async () => {
  for (const mode of ['one-time', 'old-agent']) {
    const f = routeFixture({ mode });
    for (const host of ['192.168.1.10', 'rev4a.example.com']) {
      for (const protocol of ['http:', 'https:']) {
        const result = await f.open(host, protocol, { 'x-forwarded-proto': 'https' });
        assert.equal(result.status, 302);
        const expected = await devicesFixture(mode).devices.resolveControlUiUrl('fixture-agent', host, port);
        assert.equal(result.headers.Location, expected.url);
      }
    }
    assert.deepEqual(f.warnings, []);
  }
});

await test('?tunnel=1 answers JSON built for localhost, for both link kinds, never a host from the query or Host', async () => {
  for (const mode of ['one-time', 'old-agent']) {
    const f = routeFixture({ mode });
    for (const host of ['192.168.1.10', 'rev4a.example.com', 'localhost', '[::1]']) {
      const result = await f.open(host, 'http:', {}, '?tunnel=1&host=evil.example&url=http://evil.example');
      assert.equal(result.status, 200);
      assert.equal(result.headers['Cache-Control'], 'no-store');
      assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
      const body = JSON.parse(result.body);
      assert.equal(body.port, port);
      const link = new URL(body.url);
      assert.equal(link.hostname, 'localhost');
      assert.equal(link.port, port);
      if (mode === 'one-time') assert.equal(new URLSearchParams(link.hash.slice(1)).get('gatewayUrl').startsWith('ws://localhost:'), true);
      else assert.equal(body.url, `http://localhost:${port}/#token=${encodeURIComponent(token)}`);
    }
    assert.deepEqual(f.warnings, []);
  }
});

await test('?tunnel=1 keeps the job destination and answers errors as JSON', async () => {
  const f = routeFixture();
  const result = await f.open('192.168.1.10', 'http:', {}, `?tunnel=1&job=${job}`);
  const body = JSON.parse(result.body);
  assert.equal(new URL(body.url).pathname, '/prefix/control/automations');
  assert.equal(new URL(body.url).searchParams.get('job'), job);
  const bad = await f.open('192.168.1.10', 'http:', {}, '?tunnel=1&job=../x');
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /Invalid automation job id/);
});

await test('?tunnel=port answers only the port and issues no link', async () => {
  const f = routeFixture();
  const result = await f.open('192.168.1.10', 'http:', {}, '?tunnel=port');
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(result.body), { port });
});

await test('authentication still precedes link issuance and warnings', async () => {
  const denied = new Reply('denied', { status: 401 });
  const f = routeFixture({ denied });
  assert.equal(await f.open(), denied);
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(f.calls, []);
});

console.log(`\n${passed} passed`);
