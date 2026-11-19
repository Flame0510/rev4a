#!/usr/bin/env node
/** Managed route and agent Ports API fixtures. All file, auth and Docker calls are in memory. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { test } from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const domain = require('../lib/domain.js');

function load(file, dependencies, env = {}, globals = {}) {
  const source = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const context = {
    exports: {}, URL, AbortSignal, process: { env, cwd: () => '/fixture' }, require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
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

function urlFixture(file, settings = env, activeBindings = bindings, state = {}) {
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
        State: { Running: container !== 'agent-halted', ...state }, NetworkSettings: { Ports: activeBindings } };
    } },
  }, settings);
  return { urls, reads };
}

test('agentPublicUrl uses only the configured managed file, assignment and exact route', async () => {
  const off = urlFixture(render(), {});
  assert.equal(await off.urls.agentPublicUrl('agent-atlas', 3000), null);
  assert.deepEqual(off.reads, []);
  for (const file of [null, render() + domain.RELOAD_UNCONFIRMED, 'unmanaged\n' + render(),
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
  for (const state of [{ Paused: true }, { Restarting: true }]) {
    assert.equal(await urlFixture(file, env, bindings, state).urls.agentPublicUrl('agent-atlas', 3000), null);
    assert.equal(await urlFixture(file, env, bindings, state).urls.agentPublicUrl('agent-atlas', 3005), null);
  }
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

function portsFixture({ file = render(), settings = env, activeBindings = bindings, running = true, paused = false,
  output = proc, denied = null, agentExists = true, stall, deadline = new AbortController() } = {}) {
  const { urls } = urlFixture(file, settings, activeBindings);
  const calls = [];
  const reads = [];
  const aborted = signal => new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const ports = load('lib/agent-ports-status.ts', {
    'server-only': {}, 'node:net': { isIP }, './domain-urls': urls,
    'node:util': { promisify },
    'node:child_process': { execFile(program, args, opts, done) {
      calls.push({ program, args, opts });
      if (stall === 'exec') void aborted(opts.signal).catch(done);
      else if (output === null) done(new Error('Permission denied'));
      else done(null, { stdout: output });
    } },
  });
  const devices = load('lib/agent-devices.ts', {
    '@/lib/docker-exec': {},
    '@/lib/docker-socket': { dockerFetch: () => assert.fail('Unbounded Docker request') },
    '@/lib/container': { isValidAgentId: id => id === 'atlas-id' },
    '@/lib/gateway-cli': {},
  });
  const route = load('app/api/agents/[id]/ports/route.ts', {
    'next/server': { NextResponse: Response },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => denied },
    '@/lib/agent-devices': devices,
    '@/lib/agent-ports-status': ports,
    '@/lib/domain': domain,
    '@/lib/docker-socket-path': {
      dockerRequestJson: async (method, path, _timeout, signal) => {
        reads.push({ path, signal });
        assert.equal(method, 'GET');
        if (path.startsWith('/containers/json?')) {
          if (stall === 'list') return aborted(signal);
          return agentExists ? [{ Names: ['/agent-atlas'], State: running ? 'running' : 'exited' }] : [];
        }
        assert.equal(path, '/containers/agent-atlas/json');
        if (stall === 'inspect') return aborted(signal);
        return {
          State: { Running: running, Paused: paused },
          HostConfig: { PortBindings: bindings },
          NetworkSettings: { Ports: running ? activeBindings : {} },
        };
      },
    },
  }, {}, { AbortSignal: { any: signals => AbortSignal.any(signals), timeout: ms => {
    assert.equal(ms, 5000);
    return deadline.signal;
  } } });
  const get = (host = 'dashboard.example.test:3740', signal) => route.GET(
    new Request('https://dashboard.example.test/api/agents/atlas-id/ports?host=untrusted.example.test', { headers: { host }, signal }),
    { params: Promise.resolve({ id: 'atlas-id' }) },
  );
  return { calls, reads, get, ports, deadline };
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
  assert.equal(calls[0].program, 'docker');
  assert.deepEqual([...calls[0].args.slice(0, 4)], ['exec', 'agent-atlas', 'sh', '-c']);
  assert.match(calls[0].args[4], /cat \/proc\/net\/tcp && if \[ -e \/proc\/net\/tcp6 \]; then cat \/proc\/net\/tcp6/);
  assert.equal(calls[0].opts.timeout, 3000);
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
  const pending = portsFixture({ file: render() + domain.RELOAD_UNCONFIRMED });
  const ipv6 = portsFixture({ settings: {}, activeBindings: { '3002/tcp': [published(4402, '::')] } });
  const results = await Promise.all([stale, pending, ipv6].map(async ({ get }) => (await (await get('192.0.2.5')).json()).ports[0]));
  assert.deepEqual(results.map(({ hostPort, url }) => [hostPort, url]), [[5300, null], [3700, null], [4402, null]]);
  console.log('Ports stale/pending/IPv6-only [hostPort, url]:', JSON.stringify(results.map(({ hostPort, url }) => [hostPort, url])));
});

test('allocation EIO renders Create feedback and returns authenticated JSON 503 from the Ports API', async () => {
  let unreadable = true;
  let reads = 0;
  const allocator = load('lib/agent-ports-server.ts', {
    fs: { promises: {
      async lstat() { return { isFile: () => true }; },
      async readFile() {
        reads++;
        if (unreadable) throw Object.assign(new Error('Fixture EIO'), { code: 'EIO' });
        return render() + domain.RELOAD_UNCONFIRMED;
      },
    } },
    os: {},
    '@/lib/docker-socket': { dockerFetch: async () => [] },
    '@/lib/rev4a-paths': {},
    '@/lib/env-file': {},
    './agent-ports': {},
    './domain.js': domain,
    './file-lock': { withFileDirectoryLock: async (_file, operation) => operation() },
    './listen-addresses': {},
  }, env);
  const route = load('app/api/agents/ports/route.ts', {
    'next/server': { NextResponse: Response },
    '@/lib/rev4a-auth': { requireAuthJWT: async request => request.headers.has('authorization')
      ? null : Response.json({ error: 'Unauthorized' }, { status: 401 }) },
    '@/lib/agent-ports-server': allocator,
  });
  const request = (authenticated) => new Request('http://localhost/api/agents/ports', {
    headers: authenticated ? { authorization: 'Bearer fixture' } : {},
  });
  assert.equal((await route.GET(request(false))).status, 401);
  assert.equal(reads, 0);
  const unavailable = await route.GET(request(true));
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.headers.get('content-type'), /application\/json/);
  const { error } = await unavailable.json();
  assert.match(error, /Cannot read the managed Caddy file at \/fixture\/rev4a\.caddy\. Host port allocation is paused\. Fixture EIO/);

  function CreateForm() {}
  const page = load('app/agents/create/page.tsx', {
    'react/jsx-runtime': require('react/jsx-runtime'),
    'child_process': { execSync: () => '' },
    fs: { readdirSync: () => [] },
    path: {},
    '@/lib/rev4a-paths': { templatesDir: () => '/fixture/templates' },
    '@/lib/agent-ports': { REV4A_PORT: 3740 },
    '@/lib/agent-ports-server': allocator,
    '@/lib/model-catalogue': { loadOfferedModels: () => [] },
    '@/lib/agent-defaults': { readAgentDefaults: () => ({}) },
    '@/lib/agent-images': { listLocalAgentImages: async () => [], newestLocalSupportedVersion: () => null },
    '../../components/ui': { Page: 'section', PageHeader: 'header' },
    './PageClient': CreateForm,
  }, env, { setTimeout, clearTimeout });
  const result = await page.default();
  const alert = result.props.children.find(node => node.props.role === 'alert');
  assert.equal(alert.props.children, error);

  unreadable = false;
  assert.deepEqual(await (await route.GET(request(true))).json(), { ports: [3700, 3705, 3740] });
  const form = await page.default();
  assert.equal(form.type, CreateForm);
  assert.deepEqual([...form.props.usedPorts].sort((a, b) => a - b), [3700, 3705, 3740]);
});

test('stopped and paused agents have unknown listeners and no links even with a stale Caddy route', async () => {
  for (const state of [{ running: false }, { paused: true }]) {
    const { get, calls } = portsFixture(state);
    const { ports } = await (await get()).json();
    assert.deepEqual(ports.map(({ listening, url, auth }) => [listening, url, auth]), Array.from({ length: 3 }, () => [null, null, null]));
    assert.deepEqual(calls, []);
  }
});

test('IPv4 listeners are reported when the container has no tcp6 table', async () => {
  const { get } = portsFixture({ output: proc.slice(0, proc.indexOf(ipv6Header)) });
  const { ports } = await (await get()).json();
  assert.deepEqual(ports.map(({ listening }) => listening), [true, false, false]);
});

test('Ports bounds and cancels Docker list, inspect and listener reads', async () => {
  for (const [stall, status] of [['list', 504], ['inspect', 504], ['exec', 200]]) {
    for (const cancel of [false, true]) {
      const { calls, reads, get, deadline } = portsFixture({ stall });
      const request = new AbortController();
      const result = get(undefined, request.signal);
      await new Promise(resolve => setImmediate(resolve));
      const signal = stall === 'exec' ? calls[0].opts.signal : reads.at(-1).signal;
      assert.ok(reads.every(read => read.signal === signal));
      (cancel ? request : deadline).abort();
      assert.equal(signal.aborted, true);
      const response = await result;
      assert.equal(response.status, cancel && status === 504 ? 503 : status);
      if (status === 200) assert.ok((await response.json()).ports.every(row => row.listening === null));
      else assert.match((await response.json()).error, cancel ? /Could not read/ : /timed out/);
    }
  }
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

test('Ports panel refetches for running state and binding changes and clears rows after a failed refresh', async () => {
  const hooks = [];
  const effects = [];
  const requests = [];
  let hook = 0;
  const changed = (slot, deps) => !hooks[slot] || deps.some((dep, i) => dep !== hooks[slot].deps[i]);
  const react = {
    useState(initial) {
      const slot = hook++;
      if (!(slot in hooks)) hooks[slot] = initial;
      return [hooks[slot], value => { hooks[slot] = value; }];
    },
    useRef(initial) { return hooks[hook++] ??= { current: initial }; },
    useCallback(fn, deps) {
      const slot = hook++;
      if (changed(slot, deps)) hooks[slot] = { fn, deps };
      return hooks[slot].fn;
    },
    useEffect(fn, deps) {
      const slot = hook++;
      if (changed(slot, deps)) {
        hooks[slot]?.cleanup?.();
        hooks[slot] = { deps };
        effects.push(() => { hooks[slot].cleanup = fn(); });
      }
    },
  };
  const ui = Object.fromEntries(['Button', 'ConfirmModal', 'ItemList', 'Pill', 'Surface'].map(name => [name, function Primitive() {}]));
  const { default: PortsSection } = load('app/agents/PortsSection.tsx', {
    react, 'react/jsx-runtime': require('react/jsx-runtime'),
    '../components/ui': ui, './BrowserAccessSection': {},
    '@/lib/control-ui-navigation': { controlUiTunnelCommand: () => 'fixture tunnel' },
  }, {}, {
    AbortController,
    window: { location: { protocol: 'https:', hostname: 'rev4a.example.test' } },
    fetch: (url, { signal }) => new Promise(resolve => {
      assert.equal(url, '/api/agents/atlas-id/ports');
      requests.push({ signal, resolve });
    }),
  });
  function render(running, mapping = bindings) {
    hook = 0;
    const tree = PortsSection({ agentId: 'atlas-id', bindings: mapping, running });
    effects.splice(0).forEach(effect => effect());
    return tree.props.children;
  }
  const finish = async (index, ok) => {
    requests[index].resolve({ ok, json: async () => ({ ports: [{ containerPort: 3005, hostPort: 3705, listening: true, url: null }] }) });
    await new Promise(resolve => setImmediate(resolve));
  };
  render(false);
  await finish(0, true);
  assert.ok(render(false).some(node => node?.type === ui.ItemList));
  render(false, structuredClone(bindings));
  assert.equal(requests.length, 1, 'equivalent bindings should not restart the request');
  render(true);
  assert.equal(requests.length, 2);
  const updated = { ...bindings, '3005/tcp': [published(4705)] };
  render(true, updated);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].signal.aborted, true);
  await finish(2, false);
  await finish(1, true);
  const failed = render(true, updated);
  assert.ok(failed.some(node => node?.props?.role === 'alert'));
  assert.ok(!failed.some(node => node?.type === ui.ItemList));
});
