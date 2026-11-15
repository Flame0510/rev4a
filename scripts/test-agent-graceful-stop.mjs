#!/usr/bin/env node
/** Real stop/recreate/job code with mocked Docker: identities, bounds, warnings and scope. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { EventEmitter } from 'node:events';
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
function load(file, deps, names) {
  let source = fs.readFileSync(file, 'utf8');
  if (names) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    source = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(ast)).join('\n') + '\nmodule.exports = {' + names.join(',') + '};';
  }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console: { warn() {}, error() {} }, AbortController, AbortSignal, setTimeout, clearTimeout, require: name => deps[name] ?? {}, ...deps });
  return module.exports;
}
const container = { Id: 'fixture-id', Name: '/fixture', State: { Running: true }, HostConfig: { NetworkMode: 'bridge' }, Config: { Env: ['AGENT_ID=agent_fixture'], Labels: { AGENT_ID: 'agent_fixture' } } };
function harness({ stopFails = false, exitCode = 0, failedRuns = 0, conflict = false, initialRunning = true, inspect, removeFails = false, onStop, timers = {} } = {}) {
  const events = [], warnings = [], deadlines = [], inspections = [];
  let runs = 0, stopped = false;
  const runDocker = async (argv, opts) => {
    events.push(plain(argv)); deadlines.push(opts.timeoutMs);
    if (argv[0] === 'stop') { onStop?.(); if (stopFails) throw new Error('docker stop timed out'); stopped = true; }
    if (argv[0] === 'rm' && removeFails) throw new Error('removal failed');
    if (argv[0] === 'run' && ++runs <= failedRuns) throw new Error('partial run failure');
  };
  const stop = load('lib/agent-stop.ts', {
    ...timers,
    '@/lib/agent-images': { runDocker },
    '@/lib/docker-socket-path': { dockerRequestJson: async (method, path, timeout) => {
      inspections.push({ method, path, timeout });
      return inspect ? inspect(inspections.length) : { ...container, State: { Running: !stopped && initialRunning, ExitCode: exitCode } };
    } },
  });
  const recreate = load('lib/agent-recreate.ts', {
    '@/lib/agent-images': { runDocker, resolveRecreateImage: async () => 'retry-image' },
    '@/lib/agent-stop': stop,
    '@/lib/agent-setup': { getMountFlags: () => [] },
    '@/lib/agent-memory-limit': { rebuildLimitArgs: () => [] },
    '@/lib/agent-ports': { hostPortsFromArgs: () => conflict ? [3000] : [], portArgsFromBindings: () => [] },
    '@/lib/agent-ports-server': { agentPortsHostIp: () => null, assertPortArgsHostIps: () => {}, getHostPortHolders: async () => new Map([[3000, {}]]), describeHolder: () => 'other agent' },
  });
  return { events, warnings, deadlines, inspections, stop, recreate, onWarning: message => warnings.push(message) };
}
const replace = h => h.recreate.recreateAgentContainer('agent_fixture', container, 'image', { gracefulStop: true, onWarning: h.onWarning });
await test('claimed recreate stops before remove, both by the inspected ID, within 90 seconds', async () => {
  const h = harness(); await replace(h);
  assert.deepEqual(h.events.map(e => e[0]), ['stop', 'rm', 'run']);
  assert.deepEqual(h.events[0], ['stop', '-t', '60', 'fixture-id']);
  assert.deepEqual(h.events[1], ['rm', '-f', 'fixture-id']);
  assert.deepEqual(h.deadlines, [65000, 15000, 120000]);
  assert.equal(h.inspections.length, 2);
  for (const i of h.inspections) { assert.equal(i.path, '/containers/fixture-id/json'); assert.equal(i.timeout, 5000); }
  assert.ok(h.deadlines[0] + h.deadlines[1] + h.inspections.reduce((n, i) => n + i.timeout, 0) <= 90000);
  assert.equal(h.warnings.length, 0);
});
await test('stop timeout falls back to force-remove of the original ID and emits a lease warning', async () => {
  const h = harness({ stopFails: true }); await replace(h);
  assert.deepEqual(h.events.map(e => e[0]), ['stop', 'rm', 'run']);
  assert.deepEqual(h.events[1], ['rm', '-f', 'fixture-id']);
  assert.match(h.warnings[0], /timed out.*forcing.*owner lease/);
});
await test('renaming/replacing the name during stop cannot redirect removal to the new occupant', async () => {
  let occupant = 'fixture-id';
  const h = harness({ onStop: () => { occupant = 'replacement-id'; } }); await replace(h);
  assert.equal(occupant, 'replacement-id');
  assert.deepEqual(h.events[1], ['rm', '-f', 'fixture-id']);
  assert.ok(h.inspections.every(i => i.path === '/containers/fixture-id/json'));
});
for (const bad of [undefined, { ...container, Id: 'replacement-id' }, { ...container, Config: { Labels: { AGENT_ID: 'agent_other' } } }, { ...container, Config: {} }]) {
  await test(`missing ID or ownership mismatch is refused before stop/remove (${bad?.Id ?? 'absent'})`, async () => {
    const h = harness({ inspect: () => bad });
    await assert.rejects(bad ? replace(h) : h.stop.removeAgentContainer('agent_fixture', undefined), /container ID|does not belong/);
    assert.deepEqual(h.events, []);
  });
}
await test('a disappeared original refuses removal rather than resolving a replacement by name', async () => {
  const h = harness({ inspect: () => { throw new Error('Docker error 404: gone'); } });
  await assert.rejects(replace(h), /404/); assert.deepEqual(h.events, []);
});
await test('Docker stop success with exit 137 still records the forced-stop warning', async () => {
  const h = harness({ exitCode: 137 }); await replace(h);
  assert.match(h.warnings[0], /SIGKILL.*owner lease/);
});
await test('known stopped agents skip stop; port refusal leaves a running agent untouched', async () => {
  const h = harness({ initialRunning: false }); await replace(h); assert.deepEqual(h.events.map(e => e[0]), ['rm', 'run']);
  const clash = harness({ conflict: true }); await assert.rejects(replace(clash), /already published/); assert.equal(clash.events.length, 0);
});
for (const phase of ['before', 'after']) await test(`hung ${phase}-stop inspection has an independent deadline`, async () => {
  const pending = new Map(); let seq = 0;
  const h = harness({
    inspect: n => (phase === 'before' || n === 2) ? new Promise(() => {}) : container,
    timers: { setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; }, clearTimeout: id => pending.delete(id) },
  });
  const operation = replace(h);
  const settled = operation.then(() => null, error => error);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(pending.size, 1); const [timer] = pending.values(); assert.equal(timer.ms, 5000); timer.fn();
  const error = await settled;
  if (phase === 'before') { assert.match(error.message, /timed out/); assert.deepEqual(h.events, []); }
  else { assert.equal(error, null); assert.deepEqual(h.events.map(e => e[0]), ['stop', 'rm', 'run']); assert.match(h.warnings[0], /Could not confirm/); }
  assert.equal(pending.size, 0);
});
await test('removal failure is propagated and never starts a replacement', async () => {
  const h = harness({ removeFails: true }); await assert.rejects(replace(h), /removal failed/);
  assert.deepEqual(h.events.map(e => e[0]), ['stop', 'rm']);
});
await test('Update/Rollback callers keep immediate removal; failed-run cleanup keeps its former policy', async () => {
  const h = harness({ failedRuns: 2 });
  await assert.rejects(h.recreate.recreateAgentContainer('agent_fixture', container, 'image'), /partial run failure/);
  assert.deepEqual(h.events.map(e => e[0]), ['rm', 'run', 'rm', 'run', 'rm']);
  assert.deepEqual(h.events[0], ['rm', '-f', 'fixture']);
  assert.equal(h.inspections.length, 0);
  const claimed = harness({ failedRuns: 2 }); await assert.rejects(replace(claimed), /partial run failure/);
  assert.deepEqual(claimed.events.map(e => e[0]), ['stop', 'rm', 'run', 'rm', 'run', 'rm']);
});
for (const failed of [false, true]) await test(`edit job opts in and retains warning on ${failed ? 'failure' : 'success'}`, async () => {
  const rows = [];
  const { runEdit } = load('lib/agent-edit.ts', {
    resolveRecreateImage: async () => 'image', recreateAgentContainer: async (_id, _container, _image, opts) => { assert.equal(opts.gracefulStop, true); opts.onWarning('Graceful stop timed out; owner lease may remain'); },
    updateEditRow: (_id, fields) => rows.push(plain(fields)), waitForGatewayReady: async () => !failed,
    applyRuntimeConfig: async () => {}, patchRev4aProvider: async () => {}, EDIT_READY_TIMEOUT_MS: 300000,
  }, ['runEdit']);
  await runEdit(1, 'agent_fixture', container, null);
  assert.equal(rows.at(-1).status, failed ? 'failed' : 'done'); assert.match(rows.at(-1).error, /Graceful stop timed out/);
});
for (const failed of [false, true]) await test(`Recreate job opts in and retains warning on ${failed ? 'failure' : 'success'}`, async () => {
  const rows = [];
  const { runRecreate } = load('lib/agent-recreate.ts', {
    startColdBackup: async (_id, opts) => { assert.equal(opts.onWarning, undefined); return { file: 'backup' }; },
    waitForColdBackup: async () => ({ status: 'succeeded' }), updateRecreateRow: (_id, row) => rows.push(plain(row)),
    inspectAgentContainer: async () => container, recreateAgentContainer: async (_id, _container, _image, opts) => { assert.equal(opts.gracefulStop, true); opts.onWarning('Graceful stop timed out; owner lease may remain'); },
    waitForGatewayReady: async () => !failed, applyRuntimeConfig: async () => {}, patchRev4aProvider: async () => {},
    prunePrerecreateBackups: async () => {}, COLD_BACKUP_WAIT_TIMEOUT_MS: 1, RECREATE_READY_TIMEOUT_MS: 1,
    shortError: e => e.message,
  }, ['runRecreate']);
  await runRecreate(1, 'agent_fixture', 'image');
  assert.equal(rows.at(-1).status, failed ? 'failed' : 'done'); assert.match(rows.at(-1).error, /Graceful stop timed out/);
});
await test('other lifecycle entrypoints do not use the graceful helper or expanded create deadline', () => {
  for (const path of ['app/api/agents/[id]/route.ts', 'app/api/agents/create/route.ts', 'lib/cold-backup.ts', 'lib/agent-update.ts', 'lib/agent-restore.ts']) {
    assert.doesNotMatch(fs.readFileSync(path, 'utf8'), /agent-stop|onWarning|gracefulStop/, path);
  }
  assert.match(fs.readFileSync('app/api/agents/create/route.ts', 'utf8'), /maxDuration = 480/);
});
for (const stopFails of [false, true]) await test(`cold backup retains its 30 s stop and ${stopFails ? 'kill fallback' : 'normal archive'}`, async () => {
  const events = [];
  const { startColdBackup } = load('lib/cold-backup.ts', {
    isValidAgentId: () => true, inspectHelper: async () => null, agentContainerName: async () => 'fixture',
    dockerFetch: async (_method, url) => url.startsWith('/volumes/') ? { Name: 'agent-agent_fixture-data' } : { Image: 'image', State: { Running: true } },
    timestamp: () => 'fixture-time',
    runDocker: async (argv, opts) => { events.push(plain(argv)); if (argv[0] === 'stop') { assert.equal(opts.timeoutMs, 45000); if (stopFails) throw new Error('timeout'); } },
    ensureBackupsDir() {}, helperName: () => 'backup-helper', LABEL_AGENT: 'agent', LABEL_FILE: 'file', LABEL_KIND: 'kind', LABEL_PREV: 'prev', LABEL_STARTED: 'started',
    helperOwnerEnv: () => [], BACKUPS_DIR: '/fixtures', SCRIPT: 'archive', finished: new Map(), watch() {},
  }, ['startColdBackup']);
  await startColdBackup('agent_fixture', { kind: 'prerecreate', leaveStopped: true });
  assert.deepEqual(events[0], ['stop', '-t', '30', 'fixture']);
  assert.deepEqual(events.map(e => e[0]), stopFails ? ['stop', 'kill', 'run'] : ['stop', 'run']);
});
for (const thrown of [null, undefined, 'text', new Error('observer failed')]) await test(`a throwing stop-outcome observer (${String(thrown?.message ?? thrown)}) never interrupts the backup`, async () => {
  const events = [];
  const { startColdBackup } = load('lib/cold-backup.ts', {
    isValidAgentId: () => true, inspectHelper: async () => null, agentContainerName: async () => 'fixture',
    dockerFetch: async (_method, url) => url.startsWith('/volumes/') ? { Name: 'agent-agent_fixture-data' } : { Id: 'fixture-id', Image: 'image', State: { Running: true } },
    dockerRequestJson: async () => ({ State: { Running: false, ExitCode: 137 } }),
    timestamp: () => 'fixture-time',
    runDocker: async (argv) => { events.push(plain(argv)); },
    ensureBackupsDir() {}, helperName: () => 'backup-helper', LABEL_AGENT: 'agent', LABEL_FILE: 'file', LABEL_KIND: 'kind', LABEL_PREV: 'prev', LABEL_STARTED: 'started',
    helperOwnerEnv: () => [], BACKUPS_DIR: '/fixtures', SCRIPT: 'archive', finished: new Map(), watch() {},
  }, ['startColdBackup']);
  await startColdBackup('agent_fixture', { kind: 'prerecreate', leaveStopped: true, onStopOutcome: () => { throw thrown; } });
  assert.deepEqual(events.map(e => e[0]), ['stop', 'run']);
});
// Match the checker: actual runRecreate -> startColdBackup -> recreateAgentContainer,
// not a mocked rebuild that invents a warning after the backup already stopped it.
for (const outcome of ['clean', 'exit137', 'kill', 'unconfirmed']) {
  for (const failure of [null, 'archive-start', 'archive', 'gateway']) {
    await test(`Recreate consumes backup stop outcome ${outcome}, failure=${failure}`, async () => {
      const events = [], rows = [];
      let stopped = false;
      const runDocker = async (argv) => {
        events.push(plain(argv));
        if (argv[0] === 'stop') {
          if (outcome === 'kill') throw new Error('stop failed');
          stopped = true;
        }
        if (argv[0] === 'kill') stopped = true;
        if (argv[0] === 'run' && argv.includes('-d') && failure === 'archive-start') throw new Error('helper failed');
        if (argv[0] === 'start') stopped = false;
      };
      const inspect = () => ({ ...container, Image: 'image', State: { Running: !stopped, ExitCode: outcome === 'exit137' ? 137 : 0 } });
      const transport = { dockerRequestJson: async () => inspect() };
      const stop = load('lib/agent-stop.ts', { '@/lib/agent-images': { runDocker }, '@/lib/docker-socket-path': transport });
      const rebuild = load('lib/agent-recreate.ts', {
        '@/lib/agent-images': { runDocker }, '@/lib/agent-stop': stop,
        '@/lib/agent-setup': { getMountFlags: () => [] }, '@/lib/agent-memory-limit': { rebuildLimitArgs: () => [] },
        '@/lib/agent-ports': { hostPortsFromArgs: () => [], portArgsFromBindings: () => [] },
        '@/lib/agent-ports-server': { agentPortsHostIp: () => null, assertPortArgsHostIps: () => {} },
      });
      const backup = load('lib/cold-backup.ts', {
        isValidAgentId: () => true, inspectHelper: async () => null, agentContainerName: async () => 'fixture',
        dockerFetch: async (_method, url) => url.startsWith('/volumes/') ? { Name: 'agent-agent_fixture-data' } : inspect(),
        dockerRequestJson: async (_method, _url, timeout, signal) => {
          assert.equal(timeout, 5000); assert.ok(signal);
          if (outcome === 'unconfirmed') throw new Error('inspection unavailable');
          return inspect();
        },
        timestamp: () => 'fixture-time', runDocker, ensureBackupsDir() {}, helperName: () => 'backup-helper',
        LABEL_AGENT: 'agent', LABEL_FILE: 'file', LABEL_KIND: 'kind', LABEL_PREV: 'prev', LABEL_STARTED: 'started',
        helperOwnerEnv: () => [], BACKUPS_DIR: '/fixtures', SCRIPT: 'archive', finished: new Map(), watch() {},
      }, ['startColdBackup']);
      const { runRecreate } = load('lib/agent-recreate.ts', {
        ...backup, ...rebuild, inspectAgentContainer: async () => inspect(), runDocker,
        waitForColdBackup: async () => ({ status: failure === 'archive' ? 'failed' : 'succeeded', error: 'archive failed' }),
        updateRecreateRow: (_id, row) => rows.push(plain(row)), waitForGatewayReady: async () => failure !== 'gateway',
        applyRuntimeConfig: async () => {}, patchRev4aProvider: async () => {},
        prunePrerecreateBackups: async () => [], COLD_BACKUP_WAIT_TIMEOUT_MS: 1, RECREATE_READY_TIMEOUT_MS: 1,
        shortError: e => e.message,
      }, ['runRecreate']);
      await runRecreate(1, 'agent_fixture', 'image');
      assert.deepEqual(events.filter(e => e[0] === 'stop'), [['stop', '-t', '30', 'fixture']]);
      assert.equal(events.filter(e => e[0] === 'kill').length, outcome === 'kill' ? 1 : 0);
      assert.equal(rows.at(-1).status, failure ? 'failed' : 'done');
      if (outcome !== 'clean') {
        assert.match(rows.at(-1).error, /owner lease/);
        // The warning must be persisted before the archive can fail or the process restart.
        assert.match(rows.find(row => row.error)?.error, /owner lease/);
      } else if (!failure) assert.equal(rows.at(-1).error, null);
      if (!failure || failure === 'gateway') assert.ok(events.some(e => e[0] === 'rm' && e[2] === 'fixture-id'));
    });
  }
}

for (const withResponse of [false, true]) await test(`inspection deadline destroys real JSON transport, response=${withResponse}`, async () => {
  const req = new EventEmitter(), res = new EventEmitter(), timers = new Map();
  req.destroy = error => { req.destroyed = true; req.emit('error', error); };
  res.destroy = () => { res.destroyed = true; };
  req.setTimeout = ms => { assert.equal(ms, 5000); };
  req.end = () => {};
  let respond;
  const socket = load('lib/docker-socket-path.js', {
    http: { request: (_opts, callback) => { respond = callback; return req; } },
    fs: { accessSync() {}, constants: {} }, os: {}, path: {}, child_process: {},
    process: { env: { DOCKER_HOST: 'unix:///fixture.sock' } },
  });
  const stop = load('lib/agent-stop.ts', {
    '@/lib/docker-socket-path': socket,
    '@/lib/agent-images': { runDocker: () => assert.fail('must not mutate on inspection timeout') },
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const operation = stop.removeAgentContainer('agent_fixture', 'fixture-id');
  const rejected = assert.rejects(operation, /Container inspection timed out/);
  if (withResponse) { respond(res); res.emit('data', '{"trickling":'); assert.equal(res.listenerCount('data'), 1); }
  const [timer] = timers.values(); assert.equal(timer.ms, 5000); timer.fn();
  await rejected;
  assert.equal(req.destroyed, true);
  if (withResponse) {
    assert.equal(res.destroyed, true); assert.equal(res.listenerCount('data'), 0);
    res.emit('data', 'late synthetic bytes'); assert.equal(res.listenerCount('data'), 0);
  }
  assert.equal(timers.size, 0);
});
await test('successful JSON inspection removes the cancellation listener and deadline', async () => {
  const controller = new AbortController(); let request;
  const socket = load('lib/docker-socket-path.js', {
    http: { request: (_opts, callback) => {
      request = new EventEmitter(); request.destroy = () => assert.fail('completed request was destroyed');
      request.end = () => { const res = new EventEmitter(); res.statusCode = 200; callback(res); res.emit('data', '{"Id":"fixture-id"}'); res.emit('end'); };
      return request;
    } },
    fs: { accessSync() {}, constants: {} }, os: {}, path: {}, child_process: {},
    process: { env: { DOCKER_HOST: 'unix:///fixture.sock' } },
  });
  assert.equal((await socket.dockerRequestJson('GET', '/fixture', 0, controller.signal)).Id, 'fixture-id');
  controller.abort();
});
console.log(`\n${passed} passed`);
