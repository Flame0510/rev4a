#!/usr/bin/env node
/** SEC-9B: GET /api/system/listen answers the panel's effective addresses and the agent ports mode, behind auth. */
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
  vm.runInNewContext(code, { module, exports: module.exports, process, console, JSON, Array, parseInt, Error, String,
    require: (name) => { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency in ${file}: ${name}`); return dependencies[name]; },
  }, { filename: file });
  return module.exports;
}
const agentPorts = load('lib/agent-ports.ts');
let denied = null;
let agentsMode = 'all';
let keepAgentAddresses = false;
let dockerDown = false;
let containers = [];
const { GET } = load('app/api/system/listen/route.ts', {
  'next/server': { NextResponse: { json: (body, opts) => ({ body: JSON.parse(JSON.stringify(body)), status: opts?.status ?? 200 }) } },
  '@/lib/rev4a-auth': { requireAuthJWT: async () => denied },
  '@/lib/agent-ports-server': { currentAgentPortsListen: () => ({ mode: agentsMode, hostIp: keepAgentAddresses ? null : agentsMode === 'local' ? '127.0.0.1' : agentsMode === 'address' ? '10.0.0.5' : '' }) },
  '@/lib/agent-ports': agentPorts,
  '@/lib/docker-socket': { dockerFetch: async (_m, url) => { if (dockerDown) throw new Error('down'); if (url.startsWith('/containers/json')) return containers.map((c) => ({ Id: c.Id })); const info = containers.find((c) => url.includes(c.Id)); if (info?.removed) throw new Error('No such container'); return info; } },
  '@/lib/listen-addresses': require('../lib/listen-addresses.js'),
});
let passed = 0;
async function test(name, fn) {
  const saved = { state: process.env.REV4A_LISTEN_STATE, listen: process.env.REV4A_LISTEN, port: process.env.PORT };
  try { await fn(); } finally {
    for (const [k, v] of [['REV4A_LISTEN_STATE', saved.state], ['REV4A_LISTEN', saved.listen], ['PORT', saved.port]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    denied = null; agentsMode = 'all'; keepAgentAddresses = false; dockerDown = false; containers = [];
  }
  passed++; console.log(`ok   ${name}`);
}

await test('unauthenticated: the auth answer, nothing else', async () => {
  denied = { body: { error: 'Unauthorized' }, status: 401 };
  assert.equal(await GET({}), denied);
});

await test('shape: { panel: { mode, port, addresses }, agents: { mode } }, from the state server.js published', async () => {
  process.env.REV4A_LISTEN_STATE = JSON.stringify({ mode: 'local', addresses: ['127.0.0.1', '::1', '172.17.0.1'] });
  process.env.PORT = '3740';
  agentsMode = 'local';
  const r = await GET({});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { panel: { mode: 'local', port: 3740, addresses: ['127.0.0.1', '::1', '172.17.0.1'] }, startedAtMs: null, agents: { mode: 'local', differing: 0, stoppedDiffering: 0, runningDiffering: [] } });
  assert.deepEqual(Object.keys(r.body).sort(), ['agents', 'panel', 'startedAtMs']);
});

await test('mode all publishes no addresses; the agents mode is read now', async () => {
  process.env.REV4A_LISTEN_STATE = JSON.stringify({ mode: 'all', addresses: [] });
  agentsMode = 'address';
  const r = await GET({});
  assert.deepEqual(r.body.panel, { mode: 'all', port: 3740, addresses: [] });
  assert.equal(r.body.agents.mode, 'address');
});

await test('unset agent setting reports keep, distinct from explicit all, even without Docker', async () => {
  keepAgentAddresses = true;
  dockerDown = true;
  const r = await GET({});
  assert.deepEqual(r.body.agents, { mode: 'keep', differing: 0, stoppedDiffering: 0, runningDiffering: [] });
  keepAgentAddresses = false;
  assert.deepEqual((await GET({})).body.agents, { mode: 'all', differing: null, stoppedDiffering: null, runningDiffering: [] });
  const line = fs.readFileSync(path.join(root, 'app/remote-access/CurrentSetup.tsx'), 'utf8');
  assert.ok(line.includes("mode === 'keep' ? 'Each agent keeps its address'"));
});

await test('no or broken state (not started by server.js): the setting alone, no addresses, never an error', async () => {
  for (const [state, listen, expected] of [[undefined, undefined, 'all'], [undefined, 'local', 'local'], ['{not json', '10.0.0.5', 'local'], [JSON.stringify({ mode: 'weird' }), undefined, 'all']]) {
    if (state === undefined) delete process.env.REV4A_LISTEN_STATE; else process.env.REV4A_LISTEN_STATE = state;
    if (listen === undefined) delete process.env.REV4A_LISTEN; else process.env.REV4A_LISTEN = listen;
    const r = await GET({});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.panel, { mode: expected, port: 3740, addresses: [] });
  }
});

await test('differing: running agents published wider than the setting are counted; addresses only, nothing else leaks', async () => {
  const bind = (ip) => ({ State: { Running: true }, HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: ip, HostPort: '3700' }] } }, Config: { Env: ['OPENCLAW_GATEWAY_TOKEN=secret-token'] } });
  containers = [{ Id: 'a1', ...bind('') }, { Id: 'a2', ...bind('127.0.0.1') }, { Id: 'a3', ...bind('0.0.0.0') }];
  agentsMode = 'local';
  let r = await GET({});
  assert.equal(r.body.agents.differing, 2);
  assert.ok(!JSON.stringify(r.body).includes('secret-token'));
  agentsMode = 'address';
  assert.equal((await GET({})).body.agents.differing, 3);
  agentsMode = 'all';
  assert.equal((await GET({})).body.agents.differing, 1);
  agentsMode = 'local'; dockerDown = true;
  assert.equal((await GET({})).body.agents.differing, null, 'Docker unreachable: unknown, not an error');
  const line = fs.readFileSync(path.join(root, 'app/remote-access/CurrentSetup.tsx'), 'utf8');
  assert.ok(fs.readFileSync(path.join(root, 'app/remote-access/useRemoteAccess.ts'), 'utf8').includes('runningDiffering'));
  assert.ok(fs.readFileSync(path.join(root, 'app/remote-access/AgentsToRecreate.tsx'), 'utf8').includes('Recreate'));
});

await test('the dedicated page shows the guide link; System links to it', async () => {
  const line = fs.readFileSync(path.join(root, 'app/remote-access/PresetPicker.tsx'), 'utf8');
  assert.ok(line.includes('REMOTE_ACCESS_GUIDE') && line.includes('ui-link') && line.includes('↗'));
  assert.ok(fs.readFileSync(path.join(root, 'app/system/RemoteAccessSummary.tsx'), 'utf8').includes('href="/remote-access"'));
  assert.ok(fs.readFileSync(path.join(root, 'app/system/PageClient.tsx'), 'utf8').includes('<RemoteAccessSummary />'));
});

await test('stoppedDiffering counts only stopped mismatches; only running ids and display names are returned', async () => {
  const bind = (id, running, ip) => ({ Id: id, State: { Running: running }, Name: '/' + id,
    Config: { Labels: { AGENT_ID: id }, Env: ['AGENT_NAME=Name ' + id, 'PRIVATE=hidden'] },
    HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: ip, HostPort: '3700' }] } } });
  containers = [bind('running-wide', true, '0.0.0.0'), bind('stopped-wide', false, ''), bind('stopped-local', false, '127.0.0.1'), bind('running-local', true, '127.0.0.1')];
  agentsMode = 'local';
  let r = await GET({});
  assert.deepEqual(r.body.agents, { mode: 'local', differing: 1, stoppedDiffering: 1, runningDiffering: [{ id: 'running-wide', name: 'Name running-wide' }] });
  assert.ok(!JSON.stringify(r.body).includes('stopped-wide') && !JSON.stringify(r.body).includes('PRIVATE'));
  agentsMode = 'all'; r = await GET({});
  assert.deepEqual(r.body.agents, { mode: 'all', differing: 1, stoppedDiffering: 1, runningDiffering: [{ id: 'running-local', name: 'Name running-local' }] });
});

await test('restart identity changes only with the server start, including same-mode restarts', async () => {
  const previous = process.env.REV4A_STARTED_AT;
  try {
    process.env.REV4A_STARTED_AT = '12345'; assert.equal((await GET({})).body.startedAtMs, 12345);
    process.env.REV4A_STARTED_AT = '12346'; assert.equal((await GET({})).body.startedAtMs, 12346);
  } finally { if (previous === undefined) delete process.env.REV4A_STARTED_AT; else process.env.REV4A_STARTED_AT = previous; }
});

await test('one removed container does not erase remaining mismatches', async () => {
  agentsMode = 'local';
  containers = [{ Id: 'removed', removed: true }, { Id: 'alive', State: { Running: true },
    Config: { Labels: { AGENT_ID: 'alive' }, Env: ['AGENT_NAME=Alive'] },
    HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3700' }] } } }];
  const agents = (await GET({})).body.agents;
  assert.equal(agents.differing, 1); assert.equal(agents.runningDiffering[0].id, 'alive');
  console.log('REMOVED_DURING_INSPECT', JSON.stringify(agents));
});
console.log(`\n${passed} passed`);
