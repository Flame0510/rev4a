#!/usr/bin/env node
/** Managed route and agent Ports API fixtures. All file, auth and Docker calls are in memory. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const domain = require('../lib/domain.js');

function load(file, dependencies, env = {}) {
  const source = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = {
    exports: {}, URL, AbortSignal, process: { env }, require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  };
  vm.runInNewContext(source, context, { filename: file });
  return context.exports;
}

const env = { REV4A_DOMAIN: 'rev4a.example.test', REV4A_CADDY_FILE: '/fixture/rev4a.caddy' };
const published = (port, HostIp = '127.0.0.1') => ({ HostIp, HostPort: String(port) });
const bindings = {
  '3000/tcp': [published(3700)],
  '3005/tcp': [published(4705, '::1'), published(3705)],
  '3006/tcp': [published(3706, '10.0.0.5')],
  '3007/udp': [published(3707)],
  '3008/tcp': [{ HostIp: '0.0.0.0' }],
  '3010/tcp': [published(3710)],
};
const table = domain.buildNameTable([
  { containerName: 'agent-atlas', displayName: 'Atlas', running: true, activeBindings: bindings },
  { containerName: 'agent-halted', displayName: 'Halted', running: false, activeBindings: bindings },
]);
const render = () => domain.renderCaddyfile(domain.domainConfig(env), table, '$2a$14$' + 'a'.repeat(53));

function urlFixture(file, settings = env, activeBindings = bindings) {
  const reads = [];
  const urls = load('lib/domain-urls.ts', {
    'server-only': {},
    'node:fs/promises': { async readFile(...args) {
      reads.push(args);
      if (file === null) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
      return file;
    } },
    './domain.js': domain,
    './docker-socket-path.js': { dockerRequestJson: async (_method, path) => {
      const container = path.split('/')[2];
      return { Name: `/${container}`, Config: { Labels: { AGENT_ID: container } },
        State: { Running: container !== 'agent-halted' }, NetworkSettings: { Ports: activeBindings } };
    } },
  }, settings);
  return { urls, reads };
}

test('agentPublicUrl uses only the configured managed file, assignment and exact route', async () => {
  const off = urlFixture(render(), {});
  assert.equal(await off.urls.agentPublicUrl('agent-atlas', 3000), null);
  assert.deepEqual(off.reads, []);
  for (const file of [null, domain.PENDING + render(), 'unmanaged\n' + render(),
    render().replace('# Rev4a domain: rev4a.example.test', '# Rev4a domain: other.example.test'),
    render().replace(/^# Rev4a agent: agent-atlas .*\n/m, ''),
    render().replace('\thandle @atlas {', '\thandle @unrelated {')]) {
    assert.equal(await urlFixture(file).urls.agentPublicUrl('agent-atlas', 3000), null);
  }
  const file = render();
  assert.match(file, /\thandle @atlas \{\n\t\t@atlas_manifest path \/manifest\.webmanifest\n/);
  const { urls, reads } = urlFixture(file);
  assert.equal(await urls.agentPublicUrl('agent-atlas', 3000), 'https://atlas.rev4a.example.test');
  assert.deepEqual(reads, [['/fixture/rev4a.caddy', 'utf8']]);
  assert.equal(await urls.agentPublicUrl('agent-atlas', 3005), 'https://atlas-3005.rev4a.example.test');
  assert.equal(await urls.agentPublicUrl('agent-atlas', 3006), null);
  assert.equal(await urls.agentPublicUrl('agent-atlas', 3010), null);
  assert.equal(await urls.agentPublicUrl('agent-halted', 3000), null);
  assert.equal(await urls.agentPublicUrl('missing', 3000), null);
  const edgePorts = [2999, 3000, 3001, 3009, 3010, 0, -1, 3000.5, '3000', null, undefined, NaN, 1e50];
  const edgeBindings = { ...bindings, '3001/tcp': [published(3701)], '3009/tcp': [published(3709)] };
  const edgeTable = domain.buildNameTable([{ containerName: 'agent-atlas', running: true, activeBindings: edgeBindings }]);
  const { urls: edges } = urlFixture(domain.renderCaddyfile(domain.domainConfig(env), edgeTable, '$2a$14$' + 'a'.repeat(53)), env, edgeBindings);
  const values = await Promise.all(edgePorts.map((port) => edges.agentPublicUrl('agent-atlas', port)));
  assert.deepEqual(values, [null, ...['', '-3001', '-3009'].map((suffix) => `https://agent-atlas${suffix}.${env.REV4A_DOMAIN}`), ...Array(9).fill(null)]);
  console.log('Port boundaries 2999/3000/3001/3009/3010:', values.slice(0, 5), '| invalid ports: all null');
});

const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const ipv6Header = header.replace('rem_address', 'remote_address');
const proc = [
  header,
  '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000',
  '   1: 00000000:0BBE 00000000:0000 01 00000000:00000000 00:00000000 00000000',
  ipv6Header,
  '   0: 00000000000000000000000000000000:0BBD 00000000000000000000000000000000:0000 0A 0:0',
].join('\n') + '\n';

function portsFixture({ file = render(), settings = env, activeBindings = bindings, running = true, output = proc, denied = null, agentExists = true } = {}) {
  const { urls } = urlFixture(file, settings, activeBindings);
  const calls = [];
  const ports = load('lib/agent-ports-status.ts', {
    'server-only': {}, 'node:net': { isIP }, './domain-urls': urls,
    './docker-exec': { dockerExec: async (container, args, opts) => {
      calls.push({ container, args, opts });
      if (output === null) throw new Error('Permission denied');
      return output;
    } },
  });
  const route = load('app/api/agents/[id]/ports/route.ts', {
    'next/server': { NextResponse: Response },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => denied },
    '@/lib/agent-devices': {
      findAgentContainer: async (id) => {
        assert.equal(id, 'atlas-id');
        return agentExists ? { name: 'agent-atlas', running } : null;
      },
      hostnameFromHostHeader: (value) => value && new URL(`http://${value}`).hostname,
    },
    '@/lib/agent-ports-status': ports,
    '@/lib/docker-socket': {
      dockerFetch: async (method, path) => {
        assert.equal(method, 'GET');
        assert.equal(path, '/containers/agent-atlas/json');
        return {
          State: { Running: running },
          HostConfig: { PortBindings: bindings },
          NetworkSettings: { Ports: running ? activeBindings : {} },
        };
      },
    },
  });
  const get = (host = 'dashboard.example.test:3740') => route.GET(
    new Request('https://dashboard.example.test/api/agents/atlas-id/ports?host=untrusted.example.test', { headers: { host } }),
    { params: Promise.resolve({ id: 'atlas-id' }) },
  );
  return { calls, get, ports };
}

test('proc parser accepts IPv4 and IPv6 LISTEN rows, handles empty tables and rejects unreadable output', () => {
  const { ports: { parseListeningPorts } } = portsFixture();
  assert.deepEqual([...parseListeningPorts(proc)], [3000, 3005]);
  assert.deepEqual([...parseListeningPorts(`${header}\n${ipv6Header}\n`)], []);
  for (const unreadable of ['', 'Permission denied', `${header}\npartial row`]) {
    assert.equal(parseListeningPorts(unreadable), null);
  }
});

test('Ports uses the active binding for managed routes and exposes only the requested fields', async () => {
  const { get, calls } = portsFixture();
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { ports: [
    { containerPort: 3000, hostPort: 3700, listening: true, url: 'https://atlas.rev4a.example.test', auth: null },
    { containerPort: 3005, hostPort: 3705, listening: true, url: 'https://atlas-3005.rev4a.example.test', auth: 'basic' },
    { containerPort: 3006, hostPort: 3706, listening: false, url: null, auth: null },
  ] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].container, 'agent-atlas');
  assert.deepEqual([...calls[0].args], ['cat', '/proc/net/tcp', '/proc/net/tcp6']);
  assert.equal(calls[0].opts.timeoutMs, 3000);
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
});

test('Ports outside Domain mode links only to bindings reachable at the dashboard address', async () => {
  const { get } = portsFixture({ file: null, settings: {} });
  for (const [host, expected] of [
    ['dashboard.example.test', [null, null, null]],
    ['127.0.0.1:3740', ['http://127.0.0.1:3700', 'http://127.0.0.1:3705', null]],
    ['[::1]:3740', [null, 'http://[::1]:4705', null]],
    ['10.0.0.5:3740', [null, null, 'http://10.0.0.5:3706']],
  ]) {
    const { ports } = await (await get(host)).json();
    assert.deepEqual(ports.map(({ url }) => url), expected);
    assert.ok(ports.every(({ auth }) => auth === null));
  }
});

test('Ports withholds stale and pending URLs and recognizes an IPv6-only publish', async () => {
  const stale = portsFixture({ activeBindings: { ...bindings, '3000/tcp': [published(5300)] } });
  const pending = portsFixture({ file: domain.PENDING + render() });
  const ipv6 = portsFixture({ settings: {}, activeBindings: { '3002/tcp': [published(4402, '::')] } });
  const results = await Promise.all([stale, pending, ipv6].map(async ({ get }) => (await (await get('192.0.2.5')).json()).ports[0]));
  assert.deepEqual(results.map(({ hostPort, url }) => [hostPort, url]), [[5300, null], [3700, null], [4402, null]]);
  console.log('Ports stale/pending/IPv6-only [hostPort, url]:', JSON.stringify(results.map(({ hostPort, url }) => [hostPort, url])));
});

test('a stopped agent has unknown listeners and no links even with a stale Caddy route', async () => {
  const { get, calls } = portsFixture({ running: false });
  const { ports } = await (await get()).json();
  assert.deepEqual(ports.map(({ listening, url, auth }) => [listening, url, auth]), Array.from({ length: 3 }, () => [null, null, null]));
  assert.deepEqual(calls, []);
});

test('unreadable tables return unknown status, and only authenticated requests for known agents read TCP tables', async () => {
  const unreadable = portsFixture({ output: null });
  const { ports } = await (await unreadable.get()).json();
  assert.ok(ports.every(({ listening }) => listening === null));
  const denied = new Response(null, { status: 401 });
  const unauthorized = portsFixture({ denied });
  assert.equal(await unauthorized.get(), denied);
  assert.deepEqual(unauthorized.calls, []);
  const missing = portsFixture({ agentExists: false });
  assert.equal((await missing.get()).status, 404);
  assert.deepEqual(missing.calls, []);
});
