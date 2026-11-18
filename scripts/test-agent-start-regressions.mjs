#!/usr/bin/env node
/** NET-1e correction regressions: actual routes, SQL reservation and recreate worker; no host commands. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, deps = {}, globals = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const module = { exports: {} };
  const code = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console: { log() {}, warn() {}, error() {} }, process,
    require: name => { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name]; }, ...globals });
  return module.exports;
}
const rules = load('lib/agent-ports.ts');
const db = new Database(':memory:');
for (const table of ['agent_upgrades', 'agent_recreates', 'agent_restores', 'agent_edits']) {
  db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, agent_id TEXT, status TEXT, cron_model_repair_claim INTEGER)`);
}
const connection = { prepare: db.prepare.bind(db), transaction: db.transaction.bind(db), close() {} };
let busy = null, syncBusy = null, inspectHook, probeHook, commands, recreates, state, ip, setting, settingReads;
const busyDeps = { agentBusyReason: async () => { probeHook?.(); return busy; }, currentBusyReason: () => syncBusy };
const operations = load('lib/agent-operation.ts', { '@/lib/db': { openDb: () => connection }, '@/lib/agent-busy': busyDeps });
function reset() {
  for (const table of ['agent_upgrades', 'agent_recreates', 'agent_restores', 'agent_edits']) db.exec(`DELETE FROM ${table}`);
  busy = null; syncBusy = null; inspectHook = null; probeHook = null; commands = []; recreates = []; state = 'exited'; ip = '0.0.0.0'; settingReads = 0;
  setting = { mode: 'local', hostIp: '127.0.0.1' };
}
reset();
class RecreateRefusedError extends Error {}
const json = (body, opts) => ({ body: plain(body), status: opts?.status ?? 200 });
const deps = {
  'next/server': { NextResponse: { json } },
  child_process: { execSync: command => { commands.push(command); return 'running'; } },
  '@/lib/container': { isValidAgentId: id => id === 'agent_fixture', resolveAgentedContainer: () => 'agent_fixture', isLifecycleCoolingDown: () => false, markLifecycleCooldown() {} },
  '@/lib/rev4a-auth': { requireAuthJWT: async () => null }, '@/lib/agent-busy': busyDeps,
  '@/lib/agent-operation': operations, '@/lib/credentials/delivery': { reapplyWhenReady: async () => {} },
  '@/lib/docker-socket': { dockerFetch: async () => { inspectHook?.(); return { State: { Status: state }, HostConfig: { PortBindings: ip === null ? null : { '3000/tcp': [{ HostIp: ip, HostPort: '3710' }] } } }; } },
  '@/lib/agent-ports-server': { currentAgentPortsListen: () => { settingReads++; return setting; } }, '@/lib/agent-ports': rules,
  '@/lib/agent-recreate': { RecreateRefusedError, recreateErrorStatus: () => 409, startAgentRecreate: async id => { recreates.push(id); return 73; } },
};
const lifecycle = load('app/api/agents/[id]/lifecycle/route.ts', deps);
const restart = load('app/api/agents/[id]/restart/route.ts', deps);
const ctx = { params: Promise.resolve({ id: 'agent_fixture' }) };
const post = (route, body) => route.POST({ json: async () => body, text: async () => body === undefined ? '' : JSON.stringify(body) }, ctx);
let cases = 0, totals = {};
for (const hostIp of [null, '', '127.0.0.1', '10.0.0.5']) for (const binding of ['', '0.0.0.0', '::', '[::]', '127.0.0.1', '10.0.0.5', '10.0.0.6']) {
  for (const status of ['running', 'exited', 'created', 'paused', 'restarting', 'dead', 'removing', 'unknown']) {
    for (const action of ['start', 'restart', 'stop']) for (const choice of [undefined, 'as_is', 'move', null, '', 0, false, {}, [], 'invalid']) {
      reset(); setting = { hostIp, mode: hostIp === null ? 'keep' : hostIp === '' ? 'all' : hostIp === '127.0.0.1' ? 'local' : 'address' }; ip = binding; state = status;
      const invalid = choice !== undefined && choice !== 'as_is' && choice !== 'move';
      const bindings = { '3000/tcp': [{ HostIp: binding, HostPort: '3710' }] };
      const stopped = ['exited', 'created', 'dead'].includes(status);
      const gated = stopped && action !== 'stop' && rules.publishesDifferently(bindings, hostIp);
      const result = await post(lifecycle, { action, ...(choice !== undefined ? { ports: choice } : {}) });
      assert.equal(result.status, invalid ? 400 : gated && choice === undefined ? 409 : gated && choice === 'move' ? 202 : 200);
      totals[result.status] = (totals[result.status] ?? 0) + 1;
      if (invalid || (gated && choice !== 'as_is')) assert.equal(commands.length, 0);
      assert.equal(recreates.length, !invalid && gated && choice === 'move' ? 1 : 0);
      if (!stopped) assert.equal(settingReads, 0);
      if (result.status === 409) assert.deepEqual(result.body, { error: "This agent's ports do not match the Remote access setting.", code: 'ports_differ', setting: setting.mode });
      cases++;
    }
  }
}
console.log(`MATRIX ${cases} ${JSON.stringify(totals)} 409/202 docker commands=0; as_is recreates=0; port setting reads only for stopped Start/Restart`);
for (const route of [lifecycle, restart]) {
  reset(); inspectHook = () => { busy = 'A backup of this agent is running'; };
  const result = await post(route, { action: 'start', ports: 'as_is' });
  assert.equal(result.status, 409); assert.equal(commands.length, 0);
  console.log(`BUSY_DURING_INSPECT ${route === lifecycle ? 'lifecycle' : 'restart'} ${JSON.stringify(result)} commands=${JSON.stringify(commands)}`);
  reset(); let probes = 0;
  probeHook = () => { if (++probes === 3) db.prepare('INSERT INTO agent_restores (agent_id, status) VALUES (?, ?)').run('agent_fixture', 'unresolved'); };
  assert.equal((await post(route, { action: 'start', ports: 'as_is' })).status, 409); assert.equal(commands.length, 0);
  console.log(`CLAIM_DURING_FINAL_PROBE ${route === lifecycle ? 'lifecycle' : 'restart'} status=409 commands=[]`);
}
reset(); syncBusy = 'A memory limit change for this agent is being applied';
await assert.rejects(operations.runAgentOperation('agent_fixture', () => commands.push('unexpected')), operations.AgentOperationBusyError);
assert.equal(commands.length, 0);
reset(); db.prepare('INSERT INTO agent_upgrades (agent_id, status, cron_model_repair_claim) VALUES (?, ?, 1)').run('agent_fixture', 'done');
await assert.rejects(operations.runAgentOperation('agent_fixture', () => commands.push('unexpected')), operations.AgentOperationBusyError);
reset(); let inside = false;
await operations.runAgentOperation('agent_fixture', () => { inside = db.inTransaction; }); assert.equal(inside, false, 'the Docker command runs outside the claim check transaction'); assert.equal(db.inTransaction, false);
await assert.rejects(operations.runAgentOperation('agent_fixture', () => { throw new Error('Docker failed'); }), /Docker failed/);
assert.equal(db.inTransaction, false); assert.equal(await operations.runAgentOperation('agent_fixture', () => 'released'), 'released');
console.log('OPERATION_CHECK claims checked in a short transaction, command outside it; busy/cron claims refused; failure releases');
for (const choice of [undefined, 'as_is', 'move']) {
  reset(); const result = await post(restart, choice === undefined ? undefined : { ports: choice });
  assert.equal(result.status, choice === undefined ? 409 : choice === 'move' ? 202 : 200);
  assert.equal(commands.length, choice === 'as_is' ? 1 : 0); assert.equal(recreates.length, choice === 'move' ? 1 : 0);
  console.log(`STOPPED_RESTART ${choice ?? 'none'} status=${result.status} commands=${JSON.stringify(commands)} recreates=${recreates.length}`);
}
reset(); state = 'running'; assert.deepEqual(await post(restart), { status: 200, body: { success: true } }); assert.equal(settingReads, 0);
reset(); ip = null; assert.equal((await post(lifecycle, { action: 'start' })).status, 200);
for (const body of [null, {}, [], { action: 'invalid' }]) { reset(); assert.equal((await post(lifecycle, body)).status, 400); }
for (const ports of [null, '', false, {}, []]) { reset(); assert.equal((await post(restart, { ports })).status, 400); }

// Real lifecycle Move -> real recreate starter -> real worker -> real rebuild/recovery.
for (const wasRunning of [false, true]) for (const failure of ['backup', 'address', 'run']) {
  reset(); let container = { Id: 'original', Name: '/agent_fixture', State: { Running: wasRunning }, Config: { Env: [], Labels: {} }, HostConfig: { NetworkMode: 'bridge', PortBindings: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3710' }] } } };
  let finalRow; const dockerCommands = []; const inserts = [];
  const worker = load('lib/agent-recreate.ts', {
    '@/lib/docker-socket': { dockerFetch: async (_method, url) => url.startsWith('/containers/json') ? (container ? [{ Id: container.Id }] : []) : container },
    '@/lib/agent-images': { resolveRecreateImage: async () => 'image', runDocker: async argv => { dockerCommands.push(plain(argv)); if (argv[0] === 'rm') container = null; if (argv[0] === 'run') throw new Error('run failed'); } },
    '@/lib/agent-ports': rules, '@/lib/agent-ports-server': { agentPortsHostIp: () => '127.0.0.1', assertPortArgsHostIps: () => { if (failure === 'address') throw new Error('address disappeared'); }, getHostPortHolders: async () => new Map(), describeHolder: () => '' },
    '@/lib/agent-setup': { getMountFlags: () => [], applyRuntimeConfig: async () => {} }, '@/lib/container': { isValidAgentId: () => true },
    '@/lib/backups-volume': { pruneBackups: async () => [] },
    '@/lib/cold-backup': { startColdBackup: async () => { container.State.Running = false; return { file: 'backup' }; }, waitForColdBackup: async () => ({ status: failure === 'backup' ? 'failed' : 'succeeded', error: 'backup failed' }) },
    '@/lib/agent-readiness': { waitForGatewayReady: async () => true }, '@/app/api/gateway/sync': { patchRev4aProvider: async () => {} },
    '@/lib/agent-recreate-state': { insertRecreate: (...args) => { inserts.push(args); return 73; }, updateRecreateRow: (_id, row) => { if (row.status === 'failed') finalRow = plain(row); } },
    '@/lib/agent-busy': { agentBusyReason: async () => null }, '@/lib/agent-memory-limit': { rebuildLimitArgs: () => [] },
    '@/lib/agent-stop': { removeAgentContainer: async () => { container = null; } },
  });
  if (wasRunning) await worker.startAgentRecreate('agent_fixture');
  else {
    const actualRoute = load('app/api/agents/[id]/lifecycle/route.ts', { ...deps, '@/lib/agent-recreate': worker });
    assert.equal((await post(actualRoute, { action: 'start', ports: 'move' })).status, 202);
  }
  for (let i = 0; i < 30 && !finalRow; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(finalRow?.status, 'failed');
  // was_running travels with the INSERT: no moment where the active row exists without it (dr129).
  assert.deepEqual(inserts.map((args) => args[2]), [wasRunning]);
  const oldStartIssued = dockerCommands.some(argv => argv[0] === 'start' && argv[1] === 'agent_fixture');
  assert.equal(oldStartIssued, wasRunning && failure !== 'run');
  console.log(`MOVE_FAILURE ${failure} wasRunning=${wasRunning} status=${finalRow.status} oldStartIssued=${oldStartIssued} error=${JSON.stringify(finalRow.error)}`);
}
// A recreate cut off by a Rev4a restart: recovery starts the old container only when it was running at admission
// (was_running persisted before any await). NULL (rows from before 1.29.0) keeps the old behaviour.
for (const [persisted, expectStart] of [[0, false], [1, true], [null, true]]) {
  const container = { Id: 'original', Name: '/agent_fixture', State: { Running: false }, Config: { Env: [], Labels: {} }, HostConfig: { NetworkMode: 'bridge', PortBindings: {} } };
  const dockerCommands = [];
  const worker = load('lib/agent-recreate.ts', {
    '@/lib/docker-socket': { dockerFetch: async (_method, url) => url.startsWith('/containers/json') ? [{ Id: container.Id }] : container },
    '@/lib/agent-images': { resolveRecreateImage: async () => 'image', runDocker: async argv => { dockerCommands.push(plain(argv)); if (argv[0] === 'start') container.State.Running = true; } },
    '@/lib/agent-ports': rules, '@/lib/agent-ports-server': { agentPortsHostIp: () => null, assertPortArgsHostIps: () => {}, getHostPortHolders: async () => new Map(), describeHolder: () => '' },
    '@/lib/agent-setup': { getMountFlags: () => [], applyRuntimeConfig: async () => {} }, '@/lib/container': { isValidAgentId: () => true },
    '@/lib/backups-volume': { pruneBackups: async () => [] },
    '@/lib/cold-backup': { isColdBackupRunning: async () => false, waitForColdBackup: async () => null, startColdBackup: async () => ({}), coldBackupStatus: () => null },
    '@/lib/agent-readiness': { waitForGatewayReady: async () => true }, '@/app/api/gateway/sync': { patchRev4aProvider: async () => {} },
    '@/lib/agent-recreate-state': { activeRecreateAgentIds: () => new Set(['agent_fixture']), latestRecreate: () => ({ was_running: persisted }), markInterruptedRecreates: () => 1, insertRecreate: () => 1, updateRecreateRow: () => {} },
    '@/lib/agent-busy': { agentBusyReason: async () => null }, '@/lib/agent-memory-limit': { rebuildLimitArgs: () => [] },
    '@/lib/agent-stop': { removeAgentContainer: async () => {} },
  });
  assert.equal(await worker.recoverInterruptedRecreates(), 1);
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
  const started = dockerCommands.some(argv => argv[0] === 'start');
  assert.equal(started, expectStart, `was_running=${persisted}`);
  console.log(`INTERRUPTED_RECOVERY was_running=${persisted} oldStartIssued=${started}`);
}
db.close();
console.log('All agent start correction regressions passed.');
