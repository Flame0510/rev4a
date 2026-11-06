#!/usr/bin/env node
/** Checker-2 ambiguous-commit fixture with the real SQLite journal and fresh runtime modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { initializeRev4aDb } from '../lib/db-bootstrap.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-cron-durable-'));
const file = path.join(dir, 'events.db');
initializeRev4aDb(file);
function load(file, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, Date, setInterval, require: name => {
    if (!(name in dependencies)) throw Error('Unexpected import: ' + name); return dependencies[name];
  } });
  return module.exports;
}
const dbPort = { openDb: () => new Database(file) };
let busy;
const coldBackups = new Set();
const lifecycle = load('lib/agent-job-state.ts', { '@/lib/db': dbPort, '@/lib/agent-busy': { agentBusyReason: id => busy.agentBusyReason(id) } });
const journalState = load('lib/cron-account-adoption-state.ts', { '@/lib/db': dbPort });
const updates = load('lib/agent-update-state.ts', {
  '@/lib/db': dbPort, '@/lib/agent-job-state': lifecycle,
  '@/lib/cron-account-adoption-state': journalState,
  '@/lib/agent-update-resolution': {}, '@/lib/agent-update-cron': {},
});
busy = load('lib/agent-busy.ts', {
 '@/lib/cold-backup': { isColdBackupRunning: async id => coldBackups.has(id) },
 '@/lib/agent-update-state': updates,
 '@/lib/agent-recreate-state': { isRecreateActive: () => false },
 '@/lib/agent-restore-state': { isRestoreActive: () => false },
 '@/lib/agent-edit-state': { isEditActive: () => false },
 '@/lib/subscription-login': { isLoginActive: () => false },
 '@/lib/subscription-actions': { actionBusyReason: () => null },
});
let passed = 0; let sequence = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
function fixture(original = null, { loseClear = false, loseSelection = true, cli = false, rejectSelection = false } = {}) {
  const container = 'container-' + (++sequence); let revision = 1; let model = original; let bound = false; let account = null;
  let changeBeforeClear = false; let accountCount = 1; let beforeSelection = async () => {}; let beforeRepair = async () => {};
  const generations = new Map(); const lost = new Set(); const agentId = 'agent-' + sequence;
  const calls = [];
  const candidates = async () => [{ id: 'job', model, bound, account, native: false, effectiveModel: model || 'openai/gpt-6-luna' }];
  function runtime(generation = 1) {
    if (!generations.has(generation)) {
      const id = updates.insertUpdate(agentId, '2026.9.9', '2026.10.10', container);
      generations.set(generation, { id, original: model });
    }
    const { id: updateId, original: generationOriginal } = generations.get(generation);
    // No runtime object or in-memory journal survives this call. Every DB handle is short-lived.
    const state = load('lib/cron-account-adoption-state.ts', { '@/lib/db': { openDb: () => new Database(file) } });
    const journal = state.cronModelJournal(container, updateId);
    const call = async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'cron.update') {
        const saved = journal.get('job'); assert.ok(saved, 'mutation attempted without durable original');
        assert.equal(saved.original_model, generationOriginal);
        if (params.patch.payload.model?.includes('@')) { await beforeSelection(); if (rejectSelection) throw Error('rejected before commit'); }
        else await beforeRepair();
        if (changeBeforeClear && params.patch.payload.model === generationOriginal) { model = 'openai/operator-choice'; revision++; changeBeforeClear = false; }
        if (params.expectedConfigRevision !== String(revision)) throw Error('revision conflict');
        model = params.patch.payload.model; revision++; bound = !cli; account = cli ? null : 'openai:fixture';
        if (!lost.has(updateId) && ((loseSelection && model?.includes('@')) || (loseClear && model === generationOriginal))) { lost.add(updateId); throw Error('committed, response lost'); }
      }
      return { id: 'job', configRevision: String(revision), payload: { kind: 'agentTurn', model } };
    };
    const ports = { journal, isCliRoute: async () => cli, profiles: async () => Array.from({ length: accountCount }, () => ({ id: 'openai:fixture' })), candidates, call };
    const api = load('lib/agent-update-cron-account.ts', {
      '@/lib/agent-job-state': lifecycle,
      '@/lib/cron-account-adoption-state': { ...state, pendingCronModelUpdates: () => state.pendingCronModelUpdates().filter(value => value.container === container) },
      '@/lib/subscriptions': { readProfiles: ports.profiles }, '@/lib/gateway-cli': { gatewayCliArgv: args => args },
      '@/lib/docker-exec': { dockerExec: async (_container, args) => {
        assert.equal(_container, container);
        if (args[0] === 'node') return args.length > 3 ? JSON.stringify(cli) : JSON.stringify(await candidates());
        return JSON.stringify(await call(args[2], JSON.parse(args[args.indexOf('--params') + 1])));
      } },
    });
    return { api, journal, updateId, adopt: async () => {
      try { return await api.adoptCronInferenceAccount(container, '2026.9.9', '2026.10.10', updateId, ports); }
      finally { updates.updateRow(updateId, { status: 'done' }); }
    } };
  }
  return { runtime, calls, agentId, container, set beforeSelection(value) { beforeSelection = value; }, set beforeRepair(value) { beforeRepair = value; }, get model() { return model; }, get bound() { return bound; }, set bound(value) { bound = value; }, set model(value) { model = value; revision++; }, set account(value) { account = value; }, set accountCount(value) { accountCount = value; }, set changeBeforeClear(value) { changeBeforeClear = value; } };
}
try {
  await test('checker-4 concurrent selection: repair skips the active update and retries its lost response', async () => {
    const m = fixture(); const r = m.runtime();
    let selected; const selecting = new Promise(resolve => { selected = resolve; });
    let resume; const waiting = new Promise(resolve => { resume = resolve; });
    m.beforeSelection = async () => { selected(); await waiting; };
    const adoption = r.adopt(); await selecting;
    const before = m.calls.length;
    await m.runtime().api.reconcilePendingCronAccountModels();
    assert.equal(m.calls.length, before, 'repair touched an in-flight selection');
    assert.equal(r.journal.get('job').finished_at, null);
    assert.equal(await lifecycle.claimCronModelRepair(r.updateId), null, 'active Update lost its claim');
    resume(); assert.equal((await adoption).failed, 1);
    assert.ok(m.model.includes('@')); assert.equal(r.journal.get('job').finished_at, null);
    await m.runtime().api.reconcilePendingCronAccountModels();
    assert.equal(m.model, null); assert.ok(r.journal.get('job').finished_at);
    const count = m.calls.length; await m.runtime().api.reconcilePendingCronAccountModels(); assert.equal(m.calls.length, count);
  });
  for (const concurrent of [false, true]) await test('checker-4 rollback/re-upgrade keeps newer choice with lost responses; concurrent=' + concurrent, async () => {
    const m = fixture('openai/gpt-fixture'); const old = m.runtime();
    assert.equal((await old.adopt()).failed, 1);
    updates.claimRollbackUpdate(updates.latestUpdate(m.agentId));
    m.model = null; m.bound = false; m.account = null;
    updates.updateRow(old.updateId, { status: 'rolled_back' });
    const newer = m.runtime(2);
    assert.ok(old.journal.get('job').superseded_at, 'older intent was not superseded at Update start');
    const supersededAt = old.journal.get('job').superseded_at;
    assert.equal(newer.journal.get('job'), null);
    if (concurrent) m.beforeSelection = async () => {
      const before = m.calls.length;
      await old.api.reconcilePendingCronAccountModels();
      assert.equal(m.calls.length, before, 'older repair interleaved with newer selection');
    };
    assert.equal((await newer.adopt()).failed, 1);
    assert.ok(m.model.includes('@')); assert.equal(newer.journal.get('job').original_model, null);
    await old.api.reconcilePendingCronAccountModels(); await newer.api.reconcilePendingCronAccountModels();
    assert.equal(m.model, null, 'older explicit model replaced the newer Default');
    assert.equal(old.journal.get('job').superseded_at, supersededAt);
    assert.ok(newer.journal.get('job').finished_at);
    const count = m.calls.length; await newer.api.reconcilePendingCronAccountModels(); assert.equal(m.calls.length, count);
    assert.equal(await lifecycle.claimCronModelRepair(old.updateId), null, 'stale discovery acquired an old generation');
  });
  await test('Update supersedes every older unfinished scope atomically, preserving other agents and completed journals', async () => {
    const m = fixture(); const old = m.runtime(); await old.adopt();
    const legacy = journalState.cronModelJournal(m.container, 0);
    const renamed = journalState.cronModelJournal('previous-container-name', old.updateId);
    const intent = { job_id: 'another-job', profile_id: 'profile', original_model: null, temporary_model: 'openai/model@profile' };
    legacy.remember(intent); renamed.remember(intent);
    old.journal.remember({ ...intent, job_id: 'completed' }); old.journal.finish('completed');
    const completed = old.journal.get('completed');
    const other = fixture(); const independent = other.runtime(); await independent.adopt();
    const db = new Database(file);
    db.exec(`CREATE TRIGGER refuse_superseding BEFORE UPDATE OF superseded_at ON cron_account_adoptions_by_update
      BEGIN SELECT RAISE(ABORT, 'controlled superseding failure'); END;`);
    assert.throws(() => updates.insertUpdate(m.agentId, '2026.9.9', '2026.10.10', m.container), /controlled superseding failure/);
    assert.equal(updates.latestUpdate(m.agentId).id, old.updateId, 'new claim survived a failed ownership transaction');
    assert.equal(old.journal.get('job').finished_at, null); assert.equal(legacy.get('another-job').superseded_at, null);
    db.exec('DROP TRIGGER refuse_superseding'); db.close();
    const newer = m.runtime(2);
    for (const [journal, id] of [[old.journal, 'job'], [legacy, 'another-job'], [renamed, 'another-job']]) {
      const row = journal.get(id); assert.ok(row.superseded_at); assert.equal(row.finished_at, row.superseded_at);
    }
    assert.equal(old.journal.get('completed').finished_at, completed.finished_at);
    assert.equal(old.journal.get('completed').superseded_at, null);
    assert.equal(independent.journal.get('job').finished_at, null);
    const before = old.journal.get('job').superseded_at;
    journalState.supersedeCronModelUpdates(m.container, newer.updateId, m.agentId);
    assert.equal(old.journal.get('job').superseded_at, before);
    assert.ok(!journalState.pendingCronModelUpdates().some(row => row.container === m.container));
    updates.updateRow(newer.updateId, { status: 'done' });
  });
  await test('repair skips another lifecycle owner; its own claim blocks update, rollback, edit, recreate and restore', async () => {
    const m = fixture(); const r = m.runtime(); await r.adopt();
    const makeState = table => lifecycle.createJobState({ table, initialStatus: 'working', activeStatuses: ['working'], finalStatuses: ['done'], insertColumns: [], writableColumns: [] });
    const others = ['agent_edits', 'agent_recreates', 'agent_restores'].map(makeState);
    const otherId = others[0].insert(m.agentId); const before = m.calls.length;
    await r.api.reconcilePendingCronAccountModels(); assert.equal(m.calls.length, before); assert.equal(r.journal.get('job').finished_at, null);
    others[0].update(otherId, { status: 'done' });
    m.beforeRepair = async () => {
      for (const state of others) assert.throws(() => state.insert(m.agentId), error => error.code === 'REV4A_AGENT_JOB_BUSY');
      assert.throws(() => updates.insertUpdate(m.agentId, '2026.9.9', '2026.10.10', m.container), error => error.code === 'REV4A_AGENT_JOB_BUSY');
      assert.throws(() => updates.claimRollbackUpdate(updates.latestUpdate(m.agentId)), error => error.code === 'REV4A_AGENT_JOB_BUSY');
      assert.equal(updates.isUpdateActive(m.agentId), true); assert.equal(updates.activeUpdateAgentIds().has(m.agentId), false);
      assert.equal(await lifecycle.claimCronModelRepair(r.updateId), null);
    };
    await r.api.reconcilePendingCronAccountModels();
    assert.equal(m.model, null); assert.ok(r.journal.get('job').finished_at); assert.equal(updates.isUpdateActive(m.agentId), false);
  });
  await test('repair releases its claim after a failed RPC, and startup releases an interrupted claim', async () => {
    const m = fixture(); const r = m.runtime(); await r.adopt();
    m.beforeRepair = async () => { throw Error('transport unavailable'); };
    await r.api.reconcilePendingCronAccountModels(); assert.equal(updates.isUpdateActive(m.agentId), false);
    assert.equal(r.journal.get('job').finished_at, null);
    assert.ok(await lifecycle.claimCronModelRepair(r.updateId));
    assert.equal(updates.isUpdateActive(m.agentId), true);
    updates.markInterruptedUpdates(); assert.equal(updates.isUpdateActive(m.agentId), false);
    m.beforeRepair = async () => {}; await r.api.reconcilePendingCronAccountModels(); assert.equal(m.model, null);
  });
  await test('repair refuses a cold backup and an in-process owner, then retries when idle', async () => {
    const m = fixture(); const r = m.runtime(); await r.adopt(); const before = m.calls.length;
    coldBackups.add(m.agentId);
    assert.equal(await busy.agentBusyReason(m.agentId), 'A backup of this agent is running');
    assert.equal(await lifecycle.claimCronModelRepair(r.updateId), null);
    await r.api.reconcilePendingCronAccountModels();
    assert.equal(m.calls.length, before); assert.equal(updates.isUpdateActive(m.agentId), false);
    assert.equal(r.journal.get('job').finished_at, null);
    coldBackups.delete(m.agentId); assert.equal(busy.claimMemoryLimit(m.agentId), true);
    assert.equal(await lifecycle.claimCronModelRepair(r.updateId), null);
    busy.releaseMemoryLimit(m.agentId);
    await r.api.reconcilePendingCronAccountModels(); assert.equal(m.model, null); assert.ok(r.journal.get('job').finished_at);
  });
  for (const withBackup of [false, true]) await test('crash during repair then production startup never starts a stopped agent; backup=' + withBackup, async () => {
    const m = fixture(); const r = m.runtime(); await r.adopt();
    assert.ok(await lifecycle.claimCronModelRepair(r.updateId)); // Worker crashed without releasing.
    if (withBackup) coldBackups.add(m.agentId);
    const original = updates.latestUpdate(m.agentId); const starts = []; const inspections = [];
    const source = fs.readFileSync('lib/agent-update.ts', 'utf8');
    const ast = ts.createSourceFile('update.ts', source, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'recoverInterruptedUpdates');
    const context = { ...updates, console, inspectAgentContainer: async id => { inspections.push(id); return { Name: '/stopped', State: { Running: false } }; },
      startAndVerifyContainer: async (...args) => { starts.push(args); return { ok: true }; } };
    vm.createContext(context); vm.runInContext(ts.transpileModule(fn.getText(ast).replace(/^export /, '') + ';this.recover = recoverInterruptedUpdates;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    assert.equal(await context.recover(), 0); assert.equal(await context.recover(), 0);
    assert.deepEqual(starts, []); assert.deepEqual(inspections, []);
    assert.equal(updates.isUpdateActive(m.agentId), false);
    const after = updates.latestUpdate(m.agentId); assert.equal(after.cron_model_repair_claim, null);
    delete original.cron_model_repair_claim; delete after.cron_model_repair_claim; assert.deepEqual(after, original);
    assert.equal(r.journal.get('job').finished_at, null); assert.equal(coldBackups.has(m.agentId), withBackup);
    coldBackups.delete(m.agentId);
  });
  for (const original of [null, '', 'openai/gpt-6-sol']) await test('production reconciliation retries rejected selection without a repaired log: ' + JSON.stringify(original), async () => {
    const m = fixture(original, { rejectSelection: true }); const r = m.runtime();
    assert.equal((await r.adopt()).failed, 1); const warnings = []; const warn = console.warn;
    console.warn = text => warnings.push(text);
    try { await r.api.reconcilePendingCronAccountModels(); await r.api.reconcilePendingCronAccountModels(); }
    finally { console.warn = warn; }
    assert.equal(m.model, original); assert.equal(m.bound, false); assert.equal(r.journal.get('job').finished_at, null);
    assert.ok(journalState.pendingCronModelUpdates().some(row => row.update_id === r.updateId));
    assert.equal(m.calls.filter(call => call.method === 'cron.update').length, 3);
    assert.equal(warnings.length, 2); assert.ok(warnings.every(text => text.includes('0 associated, 0 no binding needed, 1 failed')));
  });
  for (const original of [null, '', 'openai/gpt-6-sol']) await test('lost association response restores original across pass/restart: ' + JSON.stringify(original), async () => {
    const m = fixture(original); let r = m.runtime(); const first = await r.adopt();
    assert.equal(first.failed, 1); assert.equal(m.bound, true); assert.ok(m.model.includes('@')); assert.equal(r.journal.get('job').original_model, original); assert.equal(r.journal.get('job').finished_at, null);
    // Re-bootstrap and re-load both production modules, exactly as after a server restart.
    initializeRev4aDb(file); r = m.runtime(); const second = await r.adopt();
    assert.equal(second.associated, 1); assert.equal(m.model, original); assert.ok(r.journal.get('job').finished_at);
    const count = m.calls.length; await m.runtime().adopt(); assert.equal(m.calls.length, count, 'finished adoption repeated');
  });
  await test('startup reconciles committed association without another Update or connected-account discovery', async () => {
    const m = fixture(); await m.runtime().adopt(); m.accountCount = 0;
    await m.runtime().api.reconcilePendingCronAccountModels(); assert.equal(m.model, null); assert.ok(m.runtime().journal.get('job').finished_at);
  });
  await test('lost clear response is finished only after next pass verifies original model', async () => {
    const m = fixture(null, { loseSelection: false, loseClear: true }); const first = await m.runtime().adopt();
    assert.equal(first.failed, 1); assert.equal(m.model, null); assert.equal(m.runtime().journal.get('job').finished_at, null);
    await m.runtime().api.reconcilePendingCronAccountModels(); assert.ok(m.runtime().journal.get('job').finished_at);
  });
  await test('a different bound account or operator model is never cleared', async () => {
    for (const changed of ['account', 'model']) {
      const m = fixture(); await m.runtime().adopt(); const before = m.calls.length;
      if (changed === 'account') m.account = 'openai:another'; else m.model = 'openai/operator-choice';
      const expected = m.model; await m.runtime().api.reconcilePendingCronAccountModels();
      assert.equal(m.model, expected); assert.ok(!m.calls.slice(before).some(call => call.method === 'cron.update')); assert.equal(m.runtime().journal.get('job').finished_at, null);
    }
  });
  await test('revision guard preserves a concurrent operator model change during recovery', async () => {
    const m = fixture(); await m.runtime().adopt(); m.changeBeforeClear = true;
    await m.runtime().api.reconcilePendingCronAccountModels(); assert.equal(m.model, 'openai/operator-choice'); assert.equal(m.runtime().journal.get('job').finished_at, null);
  });
  await test('rollback plus re-upgrade adopts the same job again under a new update ID', async () => {
    const m = fixture(null, { loseSelection: false });
    await m.runtime(1).adopt(); assert.ok(m.runtime(1).journal.get('job').finished_at);
    m.model = null; m.bound = false; m.account = null;
    const before = m.calls.length; const second = await m.runtime(2).adopt();
    assert.equal(second.associated, 1); assert.equal(m.bound, true); assert.equal(m.model, null);
    assert.equal(m.calls.length - before, 3); assert.ok(m.runtime(2).journal.get('job').finished_at);
    assert.ok(m.runtime(1).journal.get('job').finished_at);
  });
  for (const original of [null, 'openai/gpt-6-sol']) await test('CLI route is decided before any mutation: no pin, no journal, nothing to repair: ' + original, async () => {
    const m = fixture(original, { cli: true }); const first = await m.runtime().adopt();
    assert.equal(first.failed, 0); assert.equal(first.noBindingNeeded, 1); assert.equal(m.bound, false); assert.equal(m.model, original);
    assert.equal(m.runtime().journal.get('job'), null);
    const count = m.calls.length; await m.runtime().api.reconcilePendingCronAccountModels(); assert.equal(m.calls.length, count);
  });
  await test('legacy journals migrate additively and idempotently into update scope 0', () => {
    const db = new Database(file);
    db.exec('CREATE TABLE cron_account_adoptions (container TEXT, job_id TEXT, profile_id TEXT, original_model TEXT, temporary_model TEXT, finished_at INTEGER, PRIMARY KEY(container, job_id))');
    db.prepare('INSERT INTO cron_account_adoptions VALUES (?, ?, ?, ?, ?, NULL)').run('legacy-container', 'job', 'profile', null, 'openai/model@profile');
    db.close(); initializeRev4aDb(file); initializeRev4aDb(file);
    const state = load('lib/cron-account-adoption-state.ts', { '@/lib/db': { openDb: () => new Database(file) } });
    assert.equal(state.cronModelJournal('legacy-container', 0).get('job').temporary_model, 'openai/model@profile');
    assert.equal(state.cronModelJournal('legacy-container', 1).get('job'), null);
    state.cronModelJournal('legacy-container', 0).finish('job'); initializeRev4aDb(file);
    assert.ok(state.cronModelJournal('legacy-container', 0).get('job').finished_at);
  });
  await test('journal remembers original once and repeated bootstrap preserves unfinished intent', async () => {
    const m = fixture(); await m.runtime().adopt(); const r = m.runtime();
    const saved = r.journal.remember({ job_id: 'job', profile_id: 'wrong', original_model: m.model, temporary_model: 'wrong' });
    assert.equal(saved.original_model, null); assert.equal(saved.profile_id, 'openai:fixture');
    initializeRev4aDb(file); initializeRev4aDb(file); assert.equal(m.runtime().journal.get('job').original_model, null);
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${passed} passed`);
