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
  '@/lib/docker-socket': { dockerFetch: async (_m, url) => { if (dockerDown) throw new Error('down'); return url.startsWith('/containers/json') ? containers.map((c) => ({ Id: c.Id })) : containers.find((c) => url.includes(c.Id)); } },
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
  assert.deepEqual(r.body, { panel: { mode: 'local', port: 3740, addresses: ['127.0.0.1', '::1', '172.17.0.1'] }, agents: { mode: 'local', differing: 0 } });
  assert.deepEqual(Object.keys(r.body).sort(), ['agents', 'panel']);
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
  assert.deepEqual(r.body.agents, { mode: 'keep', differing: 0 });
  keepAgentAddresses = false;
  assert.deepEqual((await GET({})).body.agents, { mode: 'all', differing: 0 });
  const line = fs.readFileSync(path.join(root, 'app/system/RemoteAccessLine.tsx'), 'utf8');
  assert.ok(line.includes("mode === 'keep' ? 'each agent keeps its address'"));
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
  const bind = (ip) => ({ HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: ip, HostPort: '3700' }] } }, Config: { Env: ['OPENCLAW_GATEWAY_TOKEN=secret-token'] } });
  containers = [{ Id: 'a1', ...bind('') }, { Id: 'a2', ...bind('127.0.0.1') }, { Id: 'a3', ...bind('0.0.0.0') }];
  agentsMode = 'local';
  let r = await GET({});
  assert.equal(r.body.agents.differing, 2);
  assert.ok(!JSON.stringify(r.body).includes('secret-token'));
  agentsMode = 'address';
  assert.equal((await GET({})).body.agents.differing, 3);
  agentsMode = 'all';
  assert.equal((await GET({})).body.agents.differing, 0);
  agentsMode = 'local'; dockerDown = true;
  assert.equal((await GET({})).body.agents.differing, null, 'Docker unreachable: unknown, not an error');
  const line = fs.readFileSync(path.join(root, 'app/system/RemoteAccessLine.tsx'), 'utf8');
  assert.ok(line.includes('to apply.') && line.includes('differing'));
});

await test('the page shows the line and the guide link; the route is wired into System', async () => {
  const line = fs.readFileSync(path.join(root, 'app/system/RemoteAccessLine.tsx'), 'utf8');
  assert.ok(line.includes('https://rev4a.app/en/docs/remote-access') && line.includes('className="ui-link"') && line.includes('↗'));
  assert.ok(fs.readFileSync(path.join(root, 'app/system/PageClient.tsx'), 'utf8').includes('<RemoteAccessLine />'));
});

console.log(`\n${passed} passed`);
