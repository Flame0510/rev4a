#!/usr/bin/env node
/** Startup interruption and operator-only resolution with production SQL and controlled Docker. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { initializeRev4aDb } from '../lib/db-bootstrap.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-restore-resolution-'));
const file = path.join(dir, 'events.db');
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(file, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(compile(fs.readFileSync(file, 'utf8')), { module, exports: module.exports, console,
    require: name => { if (!(name in dependencies)) throw Error('Unexpected import: ' + name); return dependencies[name]; } });
  return module.exports;
}
initializeRev4aDb(file);
const openDb = () => new Database(file);
const factory = load('lib/agent-job-state.ts', { '@/lib/db': { openDb } });
const state = load('lib/agent-restore-state.ts', { '@/lib/db': { openDb }, '@/lib/agent-job-state': factory });
const upgrade = factory.createJobState({ table: 'agent_upgrades', initialStatus: 'pending', activeStatuses: ['pending'], finalStatuses: ['done'], insertColumns: ['to_version'], writableColumns: [] });
const source = fs.readFileSync('lib/agent-restore.ts', 'utf8');
const ast = ts.createSourceFile('restore.ts', source, ts.ScriptTarget.Latest, true);
const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && !['pinBackup', 'prepareRestore', 'startAgentRestore', 'agentRestoreView'].includes(n.name?.text)).map(n => n.getText(ast)).join('\n');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
let sequence = 0;
function fixture({ status = 'unresolved', phase = 'cleanup_unresolved', helper = true, removeFails = false, unknown = false, ownLabel = false, absentAgent = false } = {}) {
  const agentId = 'agent_fixture_' + (++sequence);
  const id = state.insertRestore(agentId, 'fixture.tar.gz');
  state.updateRestoreRow(id, { status, phase, helper_name: 'helper-' + agentId, source_directory: '/backups/.rev4a-restore-source-' + agentId, recovery_file: 'recovery.tar.gz' });
  const events = []; let helperAlive = helper; let deleted = false; let atDocker; let unavailable = unknown;
  const own = { Id: 'own-' + agentId, Config: { Labels: { AGENT_ID: agentId } } };
  const labels = { 'rev4a.restore.agent': agentId, 'rev4a.restore.id': String(id) };
  const writer = { Id: 'helper-' + agentId, Config: { Labels: ownLabel ? { ...labels, AGENT_ID: agentId } : labels } };
  const cold = { Id: 'cold-backup', Config: { Labels: {} }, Mounts: [{ Name: `agent-${agentId}-data`, RW: false }] };
  const context = { module: { exports: {} }, console, path, BACKUPS_DIR: '/backups', running: new Set(), ...state,
    RestoreRefusedError: Error, isValidAgentId: () => true,
    fsp: { rm: async () => { deleted = true; events.push(['delete-source']); } },
    inspectAgentContainer: async () => { if (unavailable) throw Error('Docker unavailable'); return absentAgent ? null : structuredClone(own); },
    dockerRequestJson: async (_method, url) => {
      atDocker?.(); events.push(['inspect', url]); if (unavailable) throw Error('Docker unavailable');
      if (url.startsWith('/containers/json?')) {
        const filters = JSON.parse(new URL('http://docker' + url).searchParams.get('filters'));
        assert.deepEqual(filters, { label: [`rev4a.restore.agent=${agentId}`, `rev4a.restore.id=${id}`] });
        // Docker applies both labels. A cold helper with the same mount never matches.
        return [cold, ...(helperAlive ? [writer] : [])].filter(c => filters.label.every(filter => {
          const eq = filter.indexOf('='); return c.Config.Labels[filter.slice(0, eq)] === filter.slice(eq + 1);
        }));
      }
      if (helperAlive) return structuredClone(writer);
      throw Error('Docker error 404: gone');
    },
    runDocker: async args => {
      atDocker?.(); events.push(Array.from(args)); assert.equal(args.at(-1), writer.Id, 'unrelated or own container touched');
      if (args[0] === 'rm') { if (removeFails) throw Error('remove failed'); helperAlive = false; }
    },
  };
  context.exports = context.module.exports;
  vm.runInNewContext(compile(declarations + '\nmodule.exports = { recoverInterruptedRestores, resolveAgentRestore };'), context);
  return { id, agentId, events, api: context.module.exports, get row() { return state.latestRestore(agentId); }, get helperAlive() { return helperAlive; }, get deleted() { return deleted; }, set unavailable(value) { unavailable = value; }, set atDocker(fn) { atDocker = fn; } };
}
try {
  await test('startup marks extraction unresolved with helper, leaves historical rows exact and never calls Docker', async () => {
    const active = fixture({ status: 'restoring', phase: 'extracting' });
    const historical = ['done', 'failed', 'interrupted', 'unresolved'].map(status => fixture({ status }));
    const before = historical.map(m => m.row);
    assert.equal(await active.api.recoverInterruptedRestores(), 1);
    assert.equal(active.row.status, 'unresolved'); assert.equal(active.row.finished_at, null);
    assert.match(active.row.error, new RegExp('helper-' + active.agentId));
    assert.ok(state.isRestoreActive(active.agentId)); assert.equal(active.helperAlive, true);
    assert.throws(() => upgrade.insert(active.agentId, '2026.10.10'), e => e.code === 'REV4A_AGENT_JOB_BUSY');
    assert.equal(await active.api.recoverInterruptedRestores(), 0);
    historical.forEach((m, i) => { assert.deepEqual(m.row, before[i]); assert.equal(m.events.length, 0); });
    assert.equal(active.events.length, 0); assert.equal(active.deleted, false);
  });
  for (const phase of ['preflight', 'backing_up', 'backed_up', 'awaiting_ready', null]) await test('startup retains base interrupted-review behavior outside extraction: ' + phase, async () => {
    const m = fixture({ status: 'restoring', phase }); await m.api.recoverInterruptedRestores();
    assert.equal(m.row.status, 'interrupted'); assert.equal(m.row.phase, 'interrupted_review'); assert.ok(m.row.finished_at);
    assert.match(m.row.error, /no automatic extraction or restart/); assert.equal(m.events.length, 0);
  });
  await test('manual resolve removes only labelled helper; cold-backup helper and agent remain untouched', async () => {
    const m = fixture(); await m.api.resolveAgentRestore(m.agentId, m.id);
    assert.equal(m.helperAlive, false); assert.equal(m.deleted, true); assert.equal(m.row.status, 'interrupted');
    assert.equal(m.row.phase, 'manually_resolved'); assert.match(m.row.error, /reservation released/);
    assert.ok(m.events.some(e => e[0] === 'rm')); assert.ok(!m.events.some(e => JSON.stringify(e).includes('cold-backup')));
    const update = upgrade.insert(m.agentId, '2026.10.10'); upgrade.update(update, { status: 'done' });
  });
  await test('transient Docker error keeps unresolved state; explicit retry releases it', async () => {
    const m = fixture({ unknown: true }); await assert.rejects(() => m.api.resolveAgentRestore(m.agentId, m.id), /Docker may be unreachable/);
    assert.equal(m.row.status, 'unresolved'); assert.equal(m.row.finished_at, null); assert.equal(m.deleted, false);
    assert.throws(() => upgrade.insert(m.agentId, '2026.10.10'), e => e.code === 'REV4A_AGENT_JOB_BUSY');
    m.unavailable = false; await m.api.resolveAgentRestore(m.agentId, m.id); assert.equal(m.row.status, 'interrupted');
  });
  await test('manual resolve with no labelled container releases the reservation', async () => {
    const m = fixture({ helper: false }); await m.api.resolveAgentRestore(m.agentId, m.id);
    assert.equal(m.row.status, 'interrupted'); assert.match(m.row.error, /0 labelled helper/);
    assert.ok(!m.events.some(e => ['stop', 'rm'].includes(e[0])));
  });
  await test('absent agent container does not prevent labelled helper resolution', async () => {
    const m = fixture({ absentAgent: true }); await m.api.resolveAgentRestore(m.agentId, m.id);
    assert.equal(m.row.status, 'interrupted'); assert.equal(m.helperAlive, false);
  });
  for (const options of [{ removeFails: true }, { ownLabel: true }]) await test('unconfirmed cleanup or agent identity cannot release reservation: ' + JSON.stringify(options), async () => {
    const m = fixture(options); await assert.rejects(() => m.api.resolveAgentRestore(m.agentId, m.id));
    assert.equal(m.row.status, 'unresolved'); assert.equal(m.deleted, false); assert.equal(m.helperAlive, true);
    if (options.ownLabel) assert.ok(!m.events.some(e => ['stop', 'rm'].includes(e[0])));
  });
  await test('resolution holds unresolved lifecycle reservation through every Docker call and rejects duplicate requests', async () => {
    const m = fixture(); const duplicates = [];
    m.atDocker = () => {
      assert.throws(() => upgrade.insert(m.agentId, '2026.10.10'), e => e.code === 'REV4A_AGENT_JOB_BUSY');
      duplicates.push(assert.rejects(() => m.api.resolveAgentRestore(m.agentId, m.id), /another restore action/));
    };
    await m.api.resolveAgentRestore(m.agentId, m.id); await Promise.all(duplicates);
    const before = m.row; await assert.rejects(() => m.api.resolveAgentRestore(m.agentId, m.id)); assert.deepEqual(m.row, before);
  });
  await test('authenticated route rejects unauthenticated, malformed and stale confirmation requests', async () => {
    let denied = { status: 401 }; const calls = [];
    const route = load('app/api/agents/[id]/restore/resolve/route.ts', {
      'next/server': { NextResponse: { json: (body, opts = {}) => ({ body, status: opts.status ?? 200 }) } },
      '@/lib/rev4a-auth': { requireAuthJWT: async () => denied }, '@/lib/container': { isValidAgentId: id => id === 'fixture' },
      '@/lib/agent-restore': { RestoreRefusedError: Error, resolveAgentRestore: async (...args) => { calls.push(args); throw Error('Stale restore'); }, agentRestoreView: () => null },
    });
    const ctx = { params: Promise.resolve({ id: 'fixture' }) };
    assert.equal((await route.POST({ json: () => { throw Error('Auth must run first'); } }, ctx)).status, 401);
    denied = null;
    assert.equal((await route.POST({ json: async () => ({}) }, ctx)).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await route.POST({ json: async () => ({ restoreId: 7 }) }, ctx)).status, 409);
    assert.deepEqual(calls, [['fixture', 7]]);
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${passed} passed`);
