#!/usr/bin/env node
/** Cross-lifecycle admission is atomic even when an earlier Docker busy check became stale. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { initializeRev4aDb } from '../lib/db-bootstrap.mjs';

function load(file, dependencies) {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console })(
    (name) => { if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name); return dependencies[name]; }, module, module.exports);
  return module.exports;
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-operation-claims-'));
const file = path.join(dir, 'events.db');
initializeRev4aDb(file);
const factory = load('lib/agent-job-state.ts', { '@/lib/db': { openDb: () => new Database(file) } });
const spec = (table, initialStatus) => ({ table, initialStatus, activeStatuses: [initialStatus], finalStatuses: ['done', 'failed'], insertColumns: [], writableColumns: [] });
const upgradeSpec = { ...spec('agent_upgrades', 'pending'), activeStatuses: ['pending', 'rolling_back'], insertColumns: ['to_version'] };
const upgrade = factory.createJobState(upgradeSpec);
const restore = factory.createJobState(spec('agent_restores', 'restoring'));
const edit = factory.createJobState(spec('agent_edits', 'editing'));
const recreate = factory.createJobState(spec('agent_recreates', 'backing_up'));

function rollbackStarter(row, backup, onRun = () => {}) {
  const file = 'lib/agent-update.ts';
  const text = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = ['startAgentRollback', 'runRollbackStart'];
  const declarations = names.map(name => parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name));
  assert.ok(declarations.every(Boolean));
  const code = ts.transpileModule(declarations.map(node => node.getText(parsed)).join('\n') + '\nmodule.exports = { startAgentRollback };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} }; const running = new Set();
  class UpdateRefusedError extends Error {}
  vm.runInNewContext(code, { module, exports: module.exports, process: { env: {} }, running, UpdateRefusedError, isValidAgentId: () => true,
    agentBusyReason: async () => null, latestUpdate: () => row,
    ROLLBACK_FROM: ['done', 'failed', 'interrupted', 'rollback_failed'], isSupportedVersion: () => true,
    backupFileExists: backup, forgetBackupAvailability() {}, inspectAgentContainer: async () => ({}),
    claimRollbackUpdate: current => upgrade.reactivate(current.id, current.status, { status: 'rolling_back', error: null }),
    runRollback: async () => { onRun(); },
  });
  return { ...module.exports, UpdateRefusedError, running };
}
function completedUpdate(agentId) {
  const id = upgrade.insert(agentId, '2026.10.10'); upgrade.update(id, { status: 'done' });
  return { ...upgrade.latest(agentId), from_version: '2026.9.9', backup_file: 'fixture.tar.gz' };
}
try {
  await test('an existing restore claim blocks a delayed update, edit and recreate before insertion', () => {
    const id = restore.insert('agent_fixture');
    for (const insert of [() => upgrade.insert('agent_fixture', '2026.10.10'), () => edit.insert('agent_fixture'), () => recreate.insert('agent_fixture')]) {
      assert.throws(insert, (error) => error.code === 'REV4A_AGENT_JOB_BUSY');
    }
    const db = new Database(file);
    for (const table of ['agent_upgrades', 'agent_edits', 'agent_recreates']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    db.close();
    restore.update(id, { status: 'done' });
  });
  await test('an update claim blocks restore and releases only when the persisted job ends', () => {
    const id = upgrade.insert('agent_fixture', '2026.10.10');
    assert.throws(() => restore.insert('agent_fixture'), (error) => error.code === 'REV4A_AGENT_JOB_BUSY');
    upgrade.update(id, { status: 'failed' });
    const next = restore.insert('agent_fixture');
    assert.equal(restore.latest('agent_fixture').id, next);
    restore.update(next, { status: 'done' });
  });
  await test('another agent is independent and a failed transaction leaves no hidden claim', () => {
    const a = edit.insert('agent_a');
    const b = recreate.insert('agent_b');
    assert.ok(a > 0 && b > 0);
    edit.update(a, { status: 'done' });
    const c = restore.insert('agent_a');
    restore.update(c, { status: 'done' });
    recreate.update(b, { status: 'done' });
  });
  await test('a lifecycle claim made while the cold-backup probe waits is seen before returning', async () => {
    let active = false;
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const busy = load('lib/agent-busy.ts', {
      '@/lib/cold-backup': { isColdBackupRunning: () => pending },
      '@/lib/agent-update-state': { isUpdateActive: () => active },
      '@/lib/agent-recreate-state': { isRecreateActive: () => false },
      '@/lib/agent-restore-state': { isRestoreActive: () => false },
      '@/lib/agent-edit-state': { isEditActive: () => false },
      '@/lib/subscription-login': { isLoginActive: () => false },
      '@/lib/subscription-actions': { actionBusyReason: () => null },
    });
    const result = busy.agentBusyReason('agent_fixture');
    active = true; finish(false);
    assert.equal(await result, 'An update of this agent is running');
  });
  await test('rollback reactivation is atomic, preserves a refused row and cannot claim twice', () => {
    const row = completedUpdate('agent_reactivate'); const original = upgrade.latest(row.agent_id);
    const competing = restore.insert(row.agent_id);
    assert.throws(() => upgrade.reactivate(row.id, 'done', { status: 'rolling_back', error: null }), error => error.code === 'REV4A_AGENT_JOB_BUSY');
    assert.deepEqual(upgrade.latest(row.agent_id), original);
    restore.update(competing, { status: 'done' });
    upgrade.reactivate(row.id, 'done', { status: 'rolling_back', error: null });
    assert.equal(upgrade.latest(row.agent_id).status, 'rolling_back');
    assert.equal(upgrade.latest(row.agent_id).finished_at, null);
    assert.throws(() => upgrade.reactivate(row.id, 'done', { status: 'rolling_back' }), error => error.code === 'REV4A_AGENT_JOB_BUSY');
    assert.throws(() => restore.insert(row.agent_id), error => error.code === 'REV4A_AGENT_JOB_BUSY');
    upgrade.update(row.id, { status: 'done' });
  });
  await test('a superseded ended row cannot reclaim an agent from the latest update', () => {
    const old = completedUpdate('agent_superseded'); const current = completedUpdate(old.agent_id);
    assert.throws(() => upgrade.reactivate(old.id, 'done', { status: 'rolling_back' }), error => error.code === 'REV4A_AGENT_JOB_BUSY');
    assert.throws(() => upgrade.reactivate(current.id, 'pending', { status: 'rolling_back' }), /Invalid lifecycle reactivation/);
    upgrade.reactivate(current.id, 'done', { status: 'rolling_back' }); upgrade.update(current.id, { status: 'done' });
  });
  await test('the actual rollback route refuses a claim lost during backup checks with 409 and no worker', async () => {
    const row = completedUpdate('agent_rollback_race'); let finish; let runs = 0;
    const pending = new Promise(resolve => { finish = resolve; });
    const starter = rollbackStarter(row, () => pending, () => { runs++; });
    const route = load('app/api/agents/[id]/update/rollback/route.ts', {
      'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
      '@/lib/rev4a-auth': { requireAuthJWT: async () => null }, '@/lib/container': { isValidAgentId: () => true },
      '@/lib/agent-update': { ...starter, agentUpdateView: () => { throw Error('Unexpected accepted view'); } },
    });
    const response = route.POST({}, { params: Promise.resolve({ id: row.agent_id }) });
    await new Promise(resolve => setImmediate(resolve));
    const claim = restore.insert(row.agent_id); finish(true);
    const result = await response; assert.equal(result.status, 409); assert.equal(runs, 0);
    assert.equal(upgrade.latest(row.agent_id).status, 'done'); assert.equal(starter.running.size, 0);
    restore.update(claim, { status: 'done' });
  });
  await test('the actual rollback starter persists its claim before scheduling its worker', async () => {
    const row = completedUpdate('agent_rollback_solo'); let observed;
    const starter = rollbackStarter(row, async () => true, () => { observed = upgrade.latest(row.agent_id).status; });
    assert.equal(await starter.startAgentRollback(row.agent_id), row.id); assert.equal(observed, 'rolling_back');
    upgrade.update(row.id, { status: 'done' });
  });
  await test('unresolved restore persists helper identity, blocks competing claims and survives repeated bootstrap', () => {
    const real = load('lib/agent-restore-state.ts', { '@/lib/agent-job-state': factory, '@/lib/db': { openDb: () => new Database(file) } });
    const id = real.insertRestore('agent_unresolved', 'source.tar.gz');
    real.updateRestoreRow(id, { status: 'unresolved', phase: 'cleanup_unresolved', helper_name: 'restore-helper', source_directory: '/fixture-source' });
    initializeRev4aDb(file); initializeRev4aDb(file);
    assert.equal(real.isRestoreActive('agent_unresolved'), true);
    assert.ok(real.activeRestoreAgentIds().has('agent_unresolved'));
    assert.equal(real.latestRestore('agent_unresolved').finished_at, null);
    assert.equal(real.latestRestore('agent_unresolved').helper_name, 'restore-helper');
    assert.throws(() => upgrade.insert('agent_unresolved', '2026.10.10'), error => error.code === 'REV4A_AGENT_JOB_BUSY');
    assert.throws(() => recreate.insert('agent_unresolved'), error => error.code === 'REV4A_AGENT_JOB_BUSY');
    real.updateRestoreRow(id, { status: 'interrupted' });
  });
  await test('Start checks claims inside a short transaction and runs its Docker command outside it, never blocking other writers', async () => {
    const operation = load('lib/agent-operation.ts', {
      '@/lib/db': { openDb: () => new Database(file) },
      '@/lib/agent-busy': { agentBusyReason: async () => null, currentBusyReason: () => null },
    });
    const fastFactory = load('lib/agent-job-state.ts', {
      '@/lib/db': { openDb: () => new Database(file, { timeout: 1 }) },
    });
    const competing = fastFactory.createJobState(spec('agent_edits', 'editing'));
    // While the Docker command runs, other writers are not blocked (no SQLITE_BUSY for up to 35 s).
    let during = null;
    await operation.runAgentOperation('agent_start', () => { during = competing.insert('agent_start'); });
    assert.ok(during, 'a competing writer succeeds while the command runs');
    competing.update(during, { status: 'done' });
    const id = competing.insert('agent_start');
    let commands = 0;
    await assert.rejects(operation.runAgentOperation('agent_start', () => { commands++; }), operation.AgentOperationBusyError);
    assert.equal(commands, 0);
    competing.update(id, { status: 'done' });
    await assert.rejects(operation.runAgentOperation('agent_start', () => { throw new Error('Docker failed'); }), /Docker failed/);
    const next = competing.insert('agent_start'); competing.update(next, { status: 'done' });
    console.log('SQL_CHECK writers not blocked during the command; existing claim=409; failure releases=true');
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${passed} passed`);
