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
import Database from 'better-sqlite3';
import { initializeRev4aDb } from '../lib/db-bootstrap.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-bootstrap-'));
const file = path.join(dir, 'events.db');

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

test('agent_upgrades gets resolved_at and resolution once; a second run changes nothing; old rows keep their status', () => {
  const old = path.join(dir, 'old.db');
  // A database written before the columns existed.
  const db = new Database(old);
  db.exec(`CREATE TABLE agent_upgrades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, status TEXT NOT NULL,
    from_version TEXT, to_version TEXT NOT NULL, backup_file TEXT, baseline_json TEXT, verify_json TEXT, error TEXT,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER)`);
  db.prepare("INSERT INTO agent_upgrades (agent_id, status, to_version, started_at, updated_at) VALUES ('a', 'failed', '2026.9.9', 1, 1)").run();
  db.close();
  initializeRev4aDb(old);
  initializeRev4aDb(old);
  const after = new Database(old, { readonly: true });
  const cols = after.prepare('PRAGMA table_info(agent_upgrades)').all().map((c) => c.name);
  assert.equal(cols.filter((c) => c === 'resolved_at').length, 1);
  assert.equal(cols.filter((c) => c === 'resolution').length, 1);
  const r = after.prepare('SELECT status, resolved_at, resolution FROM agent_upgrades').get();
  assert.deepEqual({ ...r }, { status: 'failed', resolved_at: null, resolution: null });
  after.close();
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
