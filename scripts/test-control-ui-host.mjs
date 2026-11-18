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

function devicesFixture(mode = 'one-time', issuedUrl = browserUrl) {
  const calls = [];
  const devices = load('lib/agent-devices.ts', {
    '@/lib/docker-exec': {
      dockerExecNoFail: async () => mode === 'old-agent' ? '' : '{"version":"2026.9.9"}',
      dockerExec: async (_container, args) => {
        calls.push(args);
        if (args[0] === 'dashboard') {
          if (mode === 'failed-link') throw new Error('Fixture CLI failure');
          return JSON.stringify({ ok: true, browserUrl: issuedUrl, browserBootstrapExpiresAtMs: 123456 });
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

const publicUrl = 'https://atlas.rev4a.example.com';
for (const mode of ['one-time', 'old-agent', 'failed-link']) {
  await test(`${mode}: public links use HTTPS and WSS on the same default-port origin`, async () => {
    const { devices } = devicesFixture(mode);
    const result = await devices.linkForPublicHost('fixture-agent', publicUrl);
    const actual = new URL(result.url);
    assert.equal(actual.origin, publicUrl);
    assert.equal(actual.port, '');
    if (mode === 'one-time') {
      assert.equal(result.kind, 'one-time');
      assert.equal(actual.pathname, '/prefix/control');
      assert.equal(actual.search, '?lang=en&encoded=%2B');
      const params = new URLSearchParams(actual.hash.slice(1));
      assert.equal(params.get('gatewayUrl'), 'wss://atlas.rev4a.example.com/socket?mode=control&encoded=%2B');
      assert.equal(params.get('bootstrapToken'), bootstrap);
      assert.equal(params.get('theme'), 'dark mode');
    } else {
      assert.deepEqual([result.kind, result.url], ['token', `${publicUrl}/#token=${encodeURIComponent(token)}`]);
    }
  });
}

await test('the public Gateway link preserves explicit paths and queries and omits the bare root slash', async () => {
  const host = 'atlas.rev4a.example.com';
  for (const [suffix, expected] of [['', ''], ['/socket/', '/socket/'], ['/?next=/', '/?next=/']]) {
    const fragment = new URLSearchParams({ gatewayUrl: `ws://127.0.0.1:3000${suffix}` });
    const { devices } = devicesFixture('one-time', `http://127.0.0.1:3000/#${fragment}`);
    const result = await devices.linkForPublicHost('fixture-agent', publicUrl);
    assert.equal(new URLSearchParams(new URL(result.url).hash.slice(1)).get('gatewayUrl'), `wss://${host}${expected}`);
  }
});

await test('custom browser or Gateway schemes use the HTTPS token fallback', async () => {
  for (const [source, issuedUrl] of [
    ['browserUrl', `custom://upstream.invalid/#${fragment}`],
    ['gatewayUrl', `http://127.0.0.1:3000/#${new URLSearchParams({ gatewayUrl: 'custom://upstream.invalid/socket' })}`],
  ]) {
    const { devices, calls } = devicesFixture('one-time', issuedUrl);
    const result = await devices.linkForPublicHost('fixture-agent', publicUrl);
    assert.equal(result.kind, 'token');
    assert.equal(result.url, `${publicUrl}/#token=${encodeURIComponent(token)}`);
    assert.deepEqual(calls.map((args) => args[0]), ['dashboard', 'sh']);
    console.log(`     custom ${source} → ${result.kind}, ${new URL(result.url).origin}`);
  }
});

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
  const syncs = [];
  const lookups = [];
  const { devices, calls } = devicesFixture(mode);
  const publicRoutes = options.publicRoutes?.(syncs) ?? {
    domainIsConfigured: () => Boolean(options.publicUrl),
    requestDomainRouteSync: () => syncs.push('sync'),
    agentPublicUrl: async (container, containerPort) => {
      assert.equal(container, 'fixture-agent');
      assert.equal(containerPort, 3000);
      lookups.push(containerPort);
      return options.publicUrl ?? null;
    },
  };
  const route = load('app/api/agents/[id]/open-control-ui/route.ts', {
    'next/server': { NextResponse: Reply },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => denied },
    '@/lib/agent-readiness': { probeGateway: async () => { throw new Error('Unexpected probe'); } },
    '@/lib/gateway-state': {},
    '@/lib/docker-socket': { dockerFetch: async () => ({
      HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: options.hostIp }] } },
    }) },
    '@/lib/agent-devices': devices,
    '@/lib/domain-urls': publicRoutes,
    '@/lib/cron-ids': ids,
    '@/lib/control-ui-navigation': navigation,
  }, { process: { env: { REV4A_FORCE_INSECURE_COOKIE: '1', REV4A_DOMAIN: options.publicUrl ? 'rev4a.example.com' : undefined } }, console: { warn: (...args) => warnings.push(args) } });
  const open = (host = 'rev4a.example.com', protocol = 'http:', extraHeaders = {}, query = '') => route.GET({
    url: `${protocol}//${urlHost(host)}:3740/api/agents/fixture-agent/open-control-ui${query}`,
    headers: new Headers({ host: `${urlHost(host)}:3740`, ...extraHeaders }),
  }, { params: Promise.resolve({ id: 'fixture-agent' }) });
  return { open, warnings, calls, syncs, lookups };
}

await test('public route wins over a local bind and the request host, and keeps the automation destination', async () => {
  for (const host of ['', 'wrong.example.com']) {
    const f = routeFixture({ publicUrl, hostIp: '127.0.0.1' });
    const result = await f.open('rev4a.example.com', 'https:', { host }, `?job=${job}&host=evil.example&url=http://evil.example`);
    assert.equal(result.status, 302);
    const link = new URL(result.headers.Location);
    assert.equal(link.origin, publicUrl);
    assert.equal(link.pathname, '/prefix/control/automations');
    assert.equal(link.searchParams.get('job'), job);
    assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
    console.log(`     Host=${JSON.stringify(host)}: ${result.status} ${link.origin}${link.pathname}`);
  }
  const f = routeFixture({ hostIp: '127.0.0.1' });
  assert.equal((await f.open()).status, 409);
  assert.equal((await f.open('rev4a.example.com', 'http:', {}, '?tunnel=1')).status, 200);
  assert.equal((await f.open('rev4a.example.com', 'http:', { host: '' })).status, 400);
});

await test('stale and pending managed routes return 503 without issuing a link, and request sync without waiting', async () => {
  const domain = require('../lib/domain.js');
  const env = { REV4A_DOMAIN: 'rev4a.example.com' };
  const bindings = (port) => ({ '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] });
  const table = domain.buildNameTable([{ containerName: 'fixture-agent', displayName: 'Atlas', running: true, activeBindings: bindings(4300) }]);
  const file = domain.renderCaddyfile(domain.domainConfig(env), table);
  for (const [name, content, port] of [['stale 4300 → 5300', file, 5300], ['reload pending', domain.PENDING + file, 4300], ['missing file', null, 4300]]) {
    let finishSync;
    const f = routeFixture({ publicRoutes: (syncs) => load('lib/domain-urls.ts', {
      'server-only': {}, './domain.js': domain,
      'node:fs/promises': { readFile: async () => {
        if (content === null) throw new Error('Missing file');
        return content;
      } },
      './docker-socket-path.js': { dockerRequestJson: async () => ({ Name: '/fixture-agent', Config: { Labels: { AGENT_ID: 'fixture-agent' } },
        State: { Running: true }, NetworkSettings: { Ports: bindings(port) } }) },
      './domain-sync': { syncDomainRoutes: () => {
        syncs.push('sync');
        return new Promise((resolve) => { finishSync = resolve; });
      } },
    }, { AbortSignal, process: { env } }) });
    const result = await f.open('dashboard.example.test');
    assert.equal(result.status, 503);
    assert.equal(result.body.trim(), "This agent's address is being updated. Try again in a moment.");
    assert.equal(result.headers.Location, undefined);
    assert.deepEqual(f.calls, []);
    assert.equal((await f.open('dashboard.example.test')).status, 503);
    assert.deepEqual(f.syncs, ['sync']);
    finishSync();
    console.log(`     ${name}: ${result.status}, Location=${result.headers.Location}, links=${f.calls.length}, syncs=${f.syncs.length}; ${result.body.trim()}`);
  }
});

await test('tunnel queries stay JSON after the public route becomes available', async () => {
  const f = routeFixture({ publicUrl, hostIp: '127.0.0.1' });
  const portOnly = await f.open('dashboard.example.test', 'http:', {}, '?tunnel=port');
  assert.equal(portOnly.status, 200);
  assert.deepEqual(JSON.parse(portOnly.body), { port });
  assert.equal(portOnly.headers.Location, undefined);
  assert.deepEqual(f.calls, []);
  console.log(`     tunnel=port: ${portOnly.status} ${portOnly.body}, links=${f.calls.length}`);
  const tunnel = await f.open('dashboard.example.test', 'http:', {}, `?tunnel=1&job=${job}`);
  assert.equal(tunnel.status, 200);
  assert.equal(tunnel.headers.Location, undefined);
  const url = new URL(JSON.parse(tunnel.body).url);
  assert.equal(url.origin, `http://localhost:${port}`);
  assert.equal(url.searchParams.get('job'), job);
  assert.deepEqual(f.lookups, []);
  assert.equal(f.calls.length, 1);
  console.log(`     tunnel=1: ${tunnel.status} JSON, origin=${url.origin}, links=${f.calls.length}`);
});

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
