#!/usr/bin/env node
/** SEC-9B: recreate and the port-range edit use REV4A_AGENT_PORTS_LISTEN; unset keeps every old HostIp. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, process, Error, Set, Object, Array, Map, Number, Promise, Buffer, setTimeout,
    require: (name) => { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency in ${file}: ${name}`); return dependencies[name]; },
  }, { filename: file });
  return module.exports;
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok   ${name}`); }

const ports = load('lib/agent-ports.ts');
const listen = require('../lib/listen-addresses.js');
// The real host check, with a fixed set of interfaces.
const portsServer = load('lib/agent-ports-server.ts', {
  fs: { readFileSync: () => '' }, os: { networkInterfaces: () => ({ lo: [{ address: '127.0.0.1' }], eth0: [{ address: '10.0.0.5' }, { address: '2001:db8::5' }] }) },
  '@/lib/docker-socket': {}, '@/lib/rev4a-paths': { ENV_FILE: '/virtual/.env' },
  '@/lib/env-file': require('../lib/env-file.js'), './listen-addresses': listen, './domain.js': require('../lib/domain.js'),
  './agent-ports': ports, './file-lock': {},
});
function recreateHarness(hostIp, getHostPortHolders = async () => new Map()) {
  const calls = [];
  const dependencies = {
    '@/lib/docker-socket': {},
    '@/lib/agent-images': { runDocker: async (args) => calls.push(args) },
    '@/lib/agent-ports': ports,
    '@/lib/agent-ports-server': { getHostPortHolders, describeHolder: () => '', agentPortsHostIp: () => hostIp, assertPortArgsHostIps: portsServer.assertPortArgsHostIps },
    '@/lib/agent-setup': { getMountFlags: () => [] },
    '@/lib/agent-memory-limit': { rebuildLimitArgs: () => [] },
  };
  for (const name of ['container', 'backups-volume', 'cold-backup', 'agent-readiness', 'agent-recreate-state', 'agent-busy', 'agent-stop']) {
    dependencies[`@/lib/${name}`] = {};
  }
  dependencies['@/lib/agent-stop'] = { removeAgentContainer: async () => calls.push(['rm']) };
  dependencies['@/app/api/gateway/sync'] = {};
  return { calls, ...load('lib/agent-recreate.ts', dependencies) };
}
const container = { Id: 'original', HostConfig: { NetworkMode: 'bridge', PortBindings: {
  '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3700' }, { HostIp: '::', HostPort: '3700' }],
  '3001/tcp': [{ HostIp: '10.0.0.5', HostPort: '3701' }],
} } };
const publishes = (h) => {
  const run = h.calls.find((args) => args[0] === 'run');
  return Array.from(run.filter((_arg, i) => run[i - 1] === '-p'));
};

await test('setting unset (all): recreate keeps the old HostIp exactly (SEC-22 LC-01)', async () => {
  const h = recreateHarness(null);
  await h.recreateAgentContainer('agent_x', container, 'image');
  assert.deepEqual(publishes(h), ['3700:3000', '10.0.0.5:3701:3001']);
});

await test('setting local: the current setting wins over the old HostIp', async () => {
  const h = recreateHarness('127.0.0.1');
  await h.recreateAgentContainer('agent_x', container, 'image');
  assert.deepEqual(publishes(h), ['127.0.0.1:3700:3000', '127.0.0.1:3701:3001']);
});

await test('setting to one IPv6 address: bracketed in -p', async () => {
  const h = recreateHarness('2001:db8::5');
  await h.recreateAgentContainer('agent_x', container, 'image');
  assert.deepEqual(publishes(h), ['[2001:db8::5]:3700:3000', '[2001:db8::5]:3701:3001']);
});

await test('explicit portArgs (the range edit) are not rewritten by recreate', async () => {
  const h = recreateHarness('127.0.0.1');
  await h.recreateAgentContainer('agent_x', container, 'image', { portArgs: ports.portMappingArgs(3800, 3809, '127.0.0.1') });
  assert.deepEqual(publishes(h), ['127.0.0.1:3800-3809:3000-3009']);
});

await test('rebuild passes the proposed mapping to the allocator and propagates allocation errors before removal', async () => {
  const portArgs = ports.portMappingArgs(3699, 3700, '127.0.0.1');
  const h = recreateHarness('127.0.0.1', async (opts) => {
    assert.equal(opts.excludeContainerId, container.Id);
    assert.equal(opts.portArgs, portArgs);
    throw new Error('Cannot read the managed Caddy file. Host port allocation is paused.');
  });
  await assert.rejects(h.recreateAgentContainer('agent_x', container, 'image', { portArgs }), /port allocation is paused/);
  assert.deepEqual(h.calls, []);
});

await test('HIGH: a HostIp the host does not have refuses the recreate and the old container is never removed', async () => {
  // Setting unset, but the old binding is on an address that is gone (e.g. a VPN is down).
  const gone = { Id: 'original', HostConfig: { NetworkMode: 'bridge', PortBindings: { '3000/tcp': [{ HostIp: '100.64.0.9', HostPort: '3700' }] } } };
  const h = recreateHarness(null);
  await assert.rejects(h.recreateAgentContainer('agent_x', gone, 'image'), /100\.64\.0\.9, which this host does not have\. Nothing was changed/);
  assert.equal(h.calls.length, 0, 'no docker call at all: no rm -f, no run');
  // An address the host has, and loopback, proceed.
  const ok = recreateHarness(null);
  await ok.recreateAgentContainer('agent_x', { ...gone, HostConfig: { ...gone.HostConfig, PortBindings: { '3000/tcp': [{ HostIp: '10.0.0.5', HostPort: '3700' }] } } }, 'image');
  assert.ok(ok.calls.some((a) => a[0] === 'rm') && ok.calls.some((a) => a[0] === 'run'));
});

await test('create route builds its -p from the setting', () => {
  assert.match(fs.readFileSync(path.join(root, 'app/api/agents/create/route.ts'), 'utf8'), /portMappingArgs\([^)]*agentPortsHostIp\(\)\)/);
});

async function editPorts(hostIp, controlBindings, range = '3710-3719', extraBindings = {}) {
  const h = recreateHarness(hostIp);
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const inspected = { Id: 'original', HostConfig: { NetworkMode: 'bridge', PortBindings: {
    ...extraBindings, ...(controlBindings === undefined ? {} : { '3000/tcp': controlBindings }),
  } } };
  const edit = load('lib/agent-edit.ts', {
    '@/lib/container': { isValidAgentId: () => true },
    '@/lib/agent-ports': ports,
    '@/lib/agent-ports-server': { getUsedHostPorts: async ({ excludeContainerId }) => {
      assert.equal(excludeContainerId, inspected.Id);
      return new Set();
    }, agentPortsHostIp: () => hostIp },
    '@/lib/agent-images': { resolveRecreateImage: async () => 'image' },
    '@/lib/agent-recreate': { inspectAgentContainer: async () => inspected, recreateAgentContainer: h.recreateAgentContainer },
    '@/lib/agent-busy': { agentBusyReason: async () => null },
    '@/lib/agent-readiness': { waitForGatewayReady: async () => true },
    '@/lib/agent-setup': { applyRuntimeConfig: async () => {} },
    '@/app/api/gateway/sync': { patchRev4aProvider: async () => {} },
    '@/lib/agent-edit-state': { isEditActive: () => false, insertEdit: () => 1, updateEditRow: (_id, row) => finish(row) },
  });
  assert.equal(await edit.startAgentEdit('agent_x', { portRange: range }), 1);
  return { h, row: await finished };
}

await test('edit unset: a loopback Control UI keeps loopback for the new port range', async () => {
  const { h, row } = await editPorts(null, [{ HostIp: '127.0.0.1', HostPort: '3700' }]);
  assert.equal(row.status, 'done');
  assert.deepEqual(publishes(h), ['127.0.0.1:3710-3719:3000-3009']);
});

await test('edit unset: dynamically assigned or missing old host port still keeps its HostIp', async () => {
  for (const binding of [{ HostIp: '127.0.0.1', HostPort: '' }, { HostIp: '::1' }]) {
    const { h, row } = await editPorts(null, [binding], '3710');
    assert.equal(row.status, 'done');
    assert.deepEqual(publishes(h), [binding.HostIp === '::1' ? '[::1]:3710:3000' : '127.0.0.1:3710:3000']);
  }
});

await test('edit unset: preserve IPv6 and multiple Control UI addresses; ignore other ports', async () => {
  const { h, row } = await editPorts(null, [{ HostIp: '::1', HostPort: '3700' }, { HostIp: '10.0.0.5', HostPort: '3700' }], '3710', {
    '3001/tcp': [{ HostIp: '127.0.0.1', HostPort: '3701' }],
  });
  assert.equal(row.status, 'done');
  assert.deepEqual(publishes(h), ['[::1]:3710:3000', '10.0.0.5:3710:3000']);
});

await test('edit unset: wildcard, empty or missing Control UI HostIp retains wildcard', async () => {
  for (const bindings of [undefined, null, [], [{ HostPort: '3700' }], [{ HostIp: '', HostPort: '3700' }],
    [{ HostIp: '0.0.0.0', HostPort: '3700' }, { HostIp: '::', HostPort: '3700' }]]) {
    const { h, row } = await editPorts(null, bindings);
    assert.equal(row.status, 'done');
    assert.deepEqual(publishes(h), ['3710-3719:3000-3009']);
  }
});

await test('edit explicit all/local/IP overrides every old Control UI address', async () => {
  for (const [hostIp, prefix] of [['', ''], ['127.0.0.1', '127.0.0.1:'], ['10.0.0.5', '10.0.0.5:'], ['2001:db8::5', '[2001:db8::5]:']]) {
    const { h, row } = await editPorts(hostIp, [{ HostIp: '::1', HostPort: '3700' }, { HostIp: '127.0.0.1', HostPort: '3700' }]);
    assert.equal(row.status, 'done');
    assert.deepEqual(publishes(h), [`${prefix}3710-3719:3000-3009`]);
  }
});

await test('edit unset: a lost Control UI address fails before removing the container', async () => {
  const { h, row } = await editPorts(null, [{ HostIp: '100.64.0.9', HostPort: '3700' }]);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /100\.64\.0\.9, which this host does not have\. Nothing was changed/);
  assert.equal(h.calls.length, 0, 'no remove or run');
});

await test('edit can retain its own host port without a false conflict', async () => {
  const { h, row } = await editPorts(null, [{ HostIp: '127.0.0.1', HostPort: '3700' }], '3700');
  assert.equal(row.status, 'done');
  assert.deepEqual(publishes(h), ['127.0.0.1:3700:3000']);
});

console.log(`\n${passed} tests passed`);
