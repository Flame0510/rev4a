#!/usr/bin/env node
/**
 * Tests for lib/db-bootstrap.mjs: a first run builds the schema; a run on an initialised database
 * writes nothing (it must not wait for a writer, since openDb() runs it on every read).
 *
 *   node scripts/test-db-bootstrap.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import agentSessions from '../lib/agent-sessions.js';
import { initializeRev4aDb } from '../lib/db-bootstrap.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-bootstrap-'));
const file = path.join(dir, 'events.db');

// Run the full production bootstrap with query_only enabled on the connection it opens.
// This catches attempted no-op writes (INSERT OR IGNORE included), not just changed rows.
function queryOnlyBootstrap(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync('lib/db-bootstrap.mjs', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: 'bootstrap.ts',
  }).outputText;
  function QueryOnlyDatabase(...args) {
    const db = new Database(...args); db.pragma('query_only = ON'); return db;
  }
  const dependencies = { 'node:fs': fs, 'node:path': path,
    'better-sqlite3': QueryOnlyDatabase, './agent-sessions.js': agentSessions };
  vm.runInNewContext(code, { module, exports: module.exports, console, require: name => {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name); return dependencies[name];
  } });
  module.exports.initializeRev4aDb(file);
}

test('first run creates the schema and the meta row', () => {
  initializeRev4aDb(file);
  const db = new Database(file, { readonly: true });
  assert.equal(db.prepare('SELECT version FROM agent_sessions_meta WHERE id = 1').get().version, 1);
  db.close();
});

test('a run on an initialised database succeeds while another connection holds the write lock (busy timeout 0)', () => {
  const holder = new Database(file);
  holder.exec('BEGIN IMMEDIATE');
  try {
    initializeRev4aDb(file, { timeout: 0 });
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
});

test('a missing meta row is inserted again, an existing version is kept', () => {
  const db = new Database(file);
  db.prepare('UPDATE agent_sessions_meta SET version = 9 WHERE id = 1').run();
  db.close();
  initializeRev4aDb(file);
  const a = new Database(file);
  assert.equal(a.prepare('SELECT version FROM agent_sessions_meta WHERE id = 1').get().version, 9);
  a.prepare('DELETE FROM agent_sessions_meta').run();
  a.close();
  initializeRev4aDb(file);
  const b = new Database(file);
  assert.equal(b.prepare('SELECT version FROM agent_sessions_meta WHERE id = 1').get().version, 1);
  b.close();
});

test('agent_upgrades gets additive resolution/cron audit columns once and preserves old verification', () => {
  const old = path.join(dir, 'old.db');
  // A database written before the columns existed.
  const db = new Database(old);
  db.exec(`CREATE TABLE agent_upgrades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, status TEXT NOT NULL,
    from_version TEXT, to_version TEXT NOT NULL, backup_file TEXT, baseline_json TEXT, verify_json TEXT, error TEXT,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER)`);
  const verification = JSON.stringify({ ok: false, missingCronJobs: ['skill-collection-review-main'] });
  db.prepare("INSERT INTO agent_upgrades (agent_id, status, to_version, verify_json, error, started_at, updated_at, finished_at) VALUES ('a', 'failed', '2026.9.9', ?, 'original failure', 1, 1, 2)").run(verification);
  db.close();
  initializeRev4aDb(old);
  initializeRev4aDb(old);
  const after = new Database(old, { readonly: true });
  const cols = after.prepare('PRAGMA table_info(agent_upgrades)').all().map((c) => c.name);
  assert.equal(cols.filter((c) => c === 'resolved_at').length, 1);
  assert.equal(cols.filter((c) => c === 'resolution').length, 1);
  assert.equal(cols.filter((c) => c === 'cron_repair_json').length, 1);
  const r = after.prepare('SELECT status, verify_json, error, finished_at, resolved_at, resolution, cron_repair_json FROM agent_upgrades').get();
  assert.deepEqual({ ...r }, { status: 'failed', verify_json: verification, error: 'original failure', finished_at: 2, resolved_at: null, resolution: null, cron_repair_json: null });
  after.close();
});

test('a partially migrated update table adds only the missing audit column', () => {
  const partial = path.join(dir, 'partial.db');
  const db = new Database(partial);
  db.exec(`CREATE TABLE agent_upgrades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, status TEXT NOT NULL,
    from_version TEXT, to_version TEXT NOT NULL, backup_file TEXT, baseline_json TEXT, verify_json TEXT, error TEXT,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER, resolved_at INTEGER, resolution TEXT)`);
  db.prepare("INSERT INTO agent_upgrades (agent_id, status, to_version, resolved_at, resolution, started_at, updated_at) VALUES ('b', 'failed', '2026.10.10', 7, 'existing resolution', 1, 1)").run();
  db.close();
  initializeRev4aDb(partial);
  const writer = new Database(partial);
  writer.prepare('UPDATE agent_upgrades SET cron_repair_json = ?').run('{"retained":true}');
  writer.close();
  initializeRev4aDb(partial);
  const after = new Database(partial, { readonly: true });
  assert.deepEqual({ ...after.prepare('SELECT resolved_at, resolution, cron_repair_json FROM agent_upgrades').get() }, { resolved_at: 7, resolution: 'existing resolution', cron_repair_json: '{"retained":true}' });
  after.close();
});

test('legacy restore rows get nullable safety columns without inventing a trusted phase', () => {
  const legacy = path.join(dir, 'legacy-restore.db');
  const db = new Database(legacy);
  db.exec(`CREATE TABLE agent_restores (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
    status TEXT NOT NULL, file TEXT, error TEXT, started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, finished_at INTEGER)`);
  db.prepare("INSERT INTO agent_restores (agent_id, status, file, error, started_at, updated_at, finished_at) VALUES ('a', 'done', 'old.tar.gz', 'original', 1, 2, 3)").run();
  db.close();
  initializeRev4aDb(legacy);
  initializeRev4aDb(legacy);
  const after = new Database(legacy, { readonly: true });
  const row = after.prepare('SELECT * FROM agent_restores').get();
  assert.deepEqual({ ...row }, { id: 1, agent_id: 'a', status: 'done', file: 'old.tar.gz', error: 'original', started_at: 1, updated_at: 2, finished_at: 3, preflight_json: null, recovery_file: null, phase: null, helper_name: null, source_directory: null });
  const columns = after.prepare('PRAGMA table_info(agent_restores)').all().map((c) => c.name);
  for (const name of ['preflight_json', 'recovery_file', 'phase', 'helper_name', 'source_directory']) assert.equal(columns.filter((c) => c === name).length, 1);
  after.close();
});

test('repeated initialization preserves per-update unfinished original-model journal records', () => {
  const db = new Database(file);
  db.prepare('INSERT INTO cron_account_adoptions_by_update (container, update_id, job_id, profile_id, original_model, temporary_model) VALUES (?, ?, ?, ?, ?, ?)').run('fixture', 7, 'job', 'openai:fixture', null, 'openai/model@openai:fixture');
  db.close();
  initializeRev4aDb(file); initializeRev4aDb(file);
  const after = new Database(file);
  const record = after.prepare('SELECT original_model, temporary_model, finished_at FROM cron_account_adoptions_by_update').get();
  assert.deepEqual(record, { original_model: null, temporary_model: 'openai/model@openai:fixture', finished_at: null });
  after.close();
});

for (const rows of [0, 1, 10000]) test('legacy cron migration runs once, then query_only reopen makes no write attempt: rows=' + rows, () => {
  const f = path.join(dir, 'legacy-cron-' + rows + '.db');
  initializeRev4aDb(f);
  const db = new Database(f);
  db.exec(`CREATE TABLE cron_account_adoptions (container TEXT, job_id TEXT, profile_id TEXT,
    original_model TEXT, temporary_model TEXT, finished_at INTEGER, PRIMARY KEY(container, job_id))`);
  db.transaction(() => {
    const insert = db.prepare('INSERT INTO cron_account_adoptions VALUES (?, ?, ?, ?, ?, NULL)');
    for (let i = 0; i < rows; i++) insert.run('container', 'job-' + i, 'profile', null, 'openai/model@profile');
  })();
  db.close(); initializeRev4aDb(f); queryOnlyBootstrap(f); queryOnlyBootstrap(f);
  const after = new Database(f);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM cron_account_adoptions').get().n, rows);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM cron_account_adoptions_by_update WHERE update_id = 0').get().n, rows);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM rev4a_schema_migrations').get().n, 1);
  after.exec('BEGIN IMMEDIATE');
  try { initializeRev4aDb(f, { timeout: 0 }); } finally { after.exec('ROLLBACK'); after.close(); }
});

test('half-migrated cron journal copies missing records without overwriting newer completion and commits its marker atomically', () => {
  const f = path.join(dir, 'half-cron.db'); initializeRev4aDb(f);
  const db = new Database(f);
  db.exec(`CREATE TABLE cron_account_adoptions (container TEXT, job_id TEXT, profile_id TEXT,
    original_model TEXT, temporary_model TEXT, finished_at INTEGER, PRIMARY KEY(container, job_id));
    INSERT INTO cron_account_adoptions VALUES ('container', 'copied', 'profile', NULL, 'openai/model@profile', NULL),
      ('container', 'missing', 'profile', '', 'openai/model@profile', NULL);
    INSERT INTO cron_account_adoptions_by_update (container, update_id, job_id, profile_id, original_model, temporary_model, finished_at)
      VALUES ('container', 0, 'copied', 'profile', NULL, 'openai/model@profile', 42);
    CREATE TRIGGER fail_cron_copy BEFORE INSERT ON cron_account_adoptions_by_update
      WHEN NEW.job_id = 'missing' BEGIN SELECT RAISE(ABORT, 'controlled copy failure'); END;`);
  assert.throws(() => initializeRev4aDb(f), /controlled copy failure/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'rev4a_schema_migrations'").get(), undefined);
  db.exec(`DROP TRIGGER fail_cron_copy;
    CREATE TABLE rev4a_schema_migrations (name TEXT PRIMARY KEY);
    CREATE TRIGGER fail_cron_marker BEFORE INSERT ON rev4a_schema_migrations
      BEGIN SELECT RAISE(ABORT, 'controlled marker failure'); END;`);
  assert.throws(() => initializeRev4aDb(f), /controlled marker failure/);
  assert.equal(db.prepare("SELECT 1 FROM cron_account_adoptions_by_update WHERE job_id = 'missing'").get(), undefined, 'copy committed without its marker');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rev4a_schema_migrations').get().n, 0);
  db.exec('DROP TRIGGER fail_cron_marker'); db.close();
  initializeRev4aDb(f); queryOnlyBootstrap(f);
  const after = new Database(f);
  const records = after.prepare('SELECT job_id, original_model, finished_at FROM cron_account_adoptions_by_update ORDER BY job_id').all();
  assert.deepEqual(records, [ { job_id: 'copied', original_model: null, finished_at: 42 }, { job_id: 'missing', original_model: '', finished_at: null } ]);
  after.close();
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
