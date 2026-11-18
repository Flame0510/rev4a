#!/usr/bin/env node
/** NET-1e: execute real routes with Docker, auth and recreate mocked; never contact Docker. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, dependencies = {}, source = fs.readFileSync(file, 'utf8')) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, process, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  } }, { filename: file });
  return module.exports;
}
const portsRules = load('lib/agent-ports.ts');
const recreateSource = fs.readFileSync('lib/agent-recreate.ts', 'utf8');
const recreateErrors = load('lib/agent-recreate.ts', {}, recreateSource.slice(recreateSource.indexOf('export class RecreateRefusedError'), recreateSource.indexOf('const running =')));
const json = (body, options) => ({ body: JSON.parse(JSON.stringify(body)), status: options?.status ?? 200 });
let setting, ip, state, calls, recreates, busy, denied, cooling, marks, reads, recreateError;
function reset() {
  setting = { mode: 'local', hostIp: '127.0.0.1' }; ip = '0.0.0.0'; state = 'exited';
  calls = []; recreates = []; busy = null; denied = null; cooling = false; marks = 0; reads = 0; recreateError = null;
}
reset();
const starter = async id => { recreates.push(id); if (recreateError) throw recreateError; return 73; };
const { POST } = load('app/api/agents/[id]/lifecycle/route.ts', {
  'next/server': { NextResponse: { json } },
  child_process: { execSync: command => { calls.push(command); return command.includes('inspect') ? 'running' : ''; } },
  '@/lib/container': { resolveAgentedContainer: () => 'agent_fixture', isValidAgentId: id => id === 'agent_fixture',
    isLifecycleCoolingDown: () => cooling, markLifecycleCooldown: () => { marks++; cooling = true; } },
  '@/lib/rev4a-auth': { requireAuthJWT: async () => denied },
  '@/lib/agent-busy': { agentBusyReason: async () => busy },
  '@/lib/agent-operation': { AgentOperationBusyError: class extends Error {}, runAgentOperation: async (_id, mutate) => mutate() },
  '@/lib/credentials/delivery': { reapplyWhenReady: async () => {} },
  '@/lib/docker-socket': { dockerFetch: async () => ({ State: { Status: state }, HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: ip, HostPort: '3710' }] } } }) },
  '@/lib/agent-ports-server': { currentAgentPortsListen: () => { reads++; return setting; } },
  '@/lib/agent-ports': portsRules,
  '@/lib/agent-recreate': { startAgentRecreate: starter, ...recreateErrors },
});
const post = body => POST({ json: async () => body }, { params: Promise.resolve({ id: 'agent_fixture' }) });
let cases = 0;
for (const hostIp of [null, '', '127.0.0.1', '10.0.0.5']) {
  for (const binding of ['0.0.0.0', '127.0.0.1', '10.0.0.5']) {
    for (const status of ['running', 'exited']) for (const action of ['start', 'restart', 'stop']) {
      for (const choice of [undefined, 'as_is', 'move']) {
        reset(); setting = { hostIp, mode: hostIp === '127.0.0.1' ? 'local' : hostIp ? 'address' : 'all' }; ip = binding; state = status;
        const mismatch = hostIp !== null && (hostIp === '' ? binding !== '0.0.0.0' : hostIp !== binding);
        const gated = status !== 'running' && action !== 'stop' && mismatch;
        const result = await post({ action, ...(choice === undefined ? {} : { ports: choice }) });
        const label = JSON.stringify({ hostIp, binding, status, action, choice });
        assert.equal(result.status, gated && !choice ? 409 : gated && choice === 'move' ? 202 : 200, label);
        assert.equal(recreates.length, gated && choice === 'move' ? 1 : 0, label);
        if (gated && !choice) {
          assert.deepEqual(result.body, { error: "This agent's ports do not match the Remote access setting.", code: 'ports_differ', setting: setting.mode });
          assert.equal(marks, 0, 'the question must not consume the cooldown');
        }
        if (gated && choice === 'move') assert.deepEqual(result.body, { started: true, id: 73 });
        if (gated && choice !== 'as_is') assert.deepEqual(calls, [], `nothing executes before consent / during move: ${label}`);
        if (choice === 'as_is') assert.equal(recreates.length, 0);
        assert.ok(reads <= 1, 'setting read once'); cases++;
      }
    }
  }
}
console.log(`ok   ${cases} lifecycle decision-table cases`);
reset();
assert.equal((await post({ action: 'start' })).status, 409);
assert.equal((await post({ action: 'start', ports: 'as_is' })).status, 200, 'immediate answer is not rate limited');
assert.equal(calls.filter(c => c === 'docker start agent_fixture').length, 1);
for (const choice of ['yes', '', null, 1, {}, []]) {
  reset(); assert.equal((await post({ action: 'start', ports: choice })).status, 400); assert.equal(calls.length + recreates.length, 0);
}
reset(); busy = 'A backup is running';
assert.deepEqual(await post({ action: 'start', ports: 'move' }), { status: 409, body: { error: busy } });
assert.equal(reads + recreates.length + calls.length, 0, 'busy wins');
reset(); denied = { status: 401 }; assert.equal(await post({ action: 'start' }), denied);
for (const [error, status] of [[new recreateErrors.RecreateRefusedError('Backup is busy'), 409], [new Error('Image not available locally'), 404], [new Error('Address unavailable'), 500]]) {
  reset(); recreateError = error; assert.equal((await post({ action: 'start', ports: 'move' })).status, status); assert.equal(recreates.length, 1); assert.equal(calls.length, 0);
}
console.log('ok   409 shape, immediate choice, validation, auth, busy and recreate errors');

let listReads = 0;
const { GET } = load('app/api/agents/route.ts', {
  'next/server': { NextResponse: { json } }, '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
  '@/lib/docker-socket': { dockerAvailable: () => true, dockerFetch: async (_method, url) => url.startsWith('/containers/json')
    ? ['0.0.0.0', '127.0.0.1', '10.0.0.5'].map((ip, i) => ({ Id: String(i), Labels: { AGENT_ID: String(i) }, Names: ['/a' + i], State: i ? 'exited' : 'running' }))
    : { Config: { Env: [] }, HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: ['0.0.0.0', '127.0.0.1', '10.0.0.5'][Number(url.split('/')[2])], HostPort: '3710' }] } } } },
  '@/lib/agent-images': { listLocalAgentImages: async () => [], newestLocalSupportedVersion: () => null, containerOpenClawVersion: async () => null, imageOpenClawVersion: async () => null },
  '@/lib/agent-versions': { LOCAL_IMAGE_REPOSITORY: 'base', compareVersions: () => 0, newBuildAvailableFor: () => false },
  '@/lib/agent-ports-server': { currentAgentPortsListen: () => { listReads++; return setting; } }, '@/lib/agent-ports': portsRules,
});
for (const [hostIp, expected] of [[null, [false, false, false]], ['', [false, true, true]], ['127.0.0.1', [true, false, true]], ['10.0.0.5', [true, true, false]]]) {
  setting = { hostIp }; listReads = 0;
  assert.deepEqual((await GET({})).body.map(a => a.portsDiffer), expected); assert.equal(listReads, 1);
}
console.log('ok   agents list mismatch flags, running and stopped, setting read once');
console.log('All agent start port route tests passed.');
