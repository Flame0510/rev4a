#!/usr/bin/env node
/**
 * LIN-6: initializeRev4aDb() drops the old host-poll `sessions` and `lineage` tables (and their indexes),
 * once, without touching `events`, and never creates them again.
 *
 *   node scripts/test-legacy-lineage-drop.mjs
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-lin6-'));
const LOG = 'Dropped the old sessions/lineage tables';

/** Runs the real bootstrap and returns the lines it logged. */
function bootstrap(file) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { initializeRev4aDb(file); } finally { console.log = orig; }
  return lines;
}
function names(file, type) {
  const db = new Database(file, { readonly: true });
  const out = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type).map((r) => r.name);
  db.close();
  return out;
}
function oldDb(file, { sessions = true, lineage = true } = {}) {
  const db = new Database(file);
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT);
    CREATE INDEX idx_events_session ON events(session_id, ts);
    INSERT INTO events (ts, session_id, type) VALUES (1, 's1', 'session_started'), (2, 's1', 'session_ended');`);
  if (sessions) {
    db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, parent_id TEXT, label TEXT, model TEXT, tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, status TEXT DEFAULT 'idle', task_preview TEXT, started_at INTEGER,
      ended_at INTEGER, updated_at INTEGER, trello_card_url TEXT);
      CREATE INDEX idx_sessions_updated ON sessions(updated_at);
      CREATE INDEX idx_sessions_started ON sessions(started_at);
      INSERT INTO sessions (session_id, started_at, updated_at) VALUES ('s1', 1, 2);`);
  }
  if (lineage) {
    db.exec(`CREATE TABLE lineage (child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, declared_at INTEGER NOT NULL, agent_name TEXT, label TEXT);
      INSERT INTO lineage VALUES ('c', 'p', 1, 'a', 'l');`);
  }
  db.close();
}
function assertEventsIntact(file) {
  const db = new Database(file, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
  db.close();
  assert.ok(names(file, 'index').includes('idx_events_session'));
}

test('old schema with rows: both tables and their indexes are dropped, events untouched, one log line', () => {
  const f = path.join(dir, 'old.db');
  oldDb(f);
  const lines = bootstrap(f);
  const tables = names(f, 'table');
  assert.ok(!tables.includes('sessions') && !tables.includes('lineage'));
  assert.ok(tables.includes('agent_sessions') && tables.includes('events'));
  const idx = names(f, 'index');
  assert.ok(!idx.includes('idx_sessions_updated') && !idx.includes('idx_sessions_started'));
  assertEventsIntact(f);
  assert.equal(lines.filter((l) => l.includes(LOG)).length, 1);
});

test('a second run is a no-op: no error, no log line', () => {
  const f = path.join(dir, 'old.db');
  assert.deepEqual(bootstrap(f), []);
  assert.deepEqual(bootstrap(f), []);
  assertEventsIntact(f);
});

test('a half-migrated database with only lineage is dropped too', () => {
  const f = path.join(dir, 'half.db');
  oldDb(f, { sessions: false });
  const lines = bootstrap(f);
  assert.ok(!names(f, 'table').includes('lineage'));
  assert.equal(lines.filter((l) => l.includes(LOG)).length, 1);
  assertEventsIntact(f);
});

test('a database with only sessions is dropped too', () => {
  const f = path.join(dir, 'half2.db');
  oldDb(f, { lineage: false });
  bootstrap(f);
  assert.ok(!names(f, 'table').includes('sessions'));
  assertEventsIntact(f);
});

test('a leftover index without its table is removed quietly', () => {
  const f = path.join(dir, 'idx.db');
  oldDb(f, { sessions: false, lineage: false });
  const db = new Database(f);
  db.exec('CREATE TABLE sessions (session_id TEXT, updated_at INTEGER, started_at INTEGER); CREATE INDEX idx_sessions_updated ON sessions(updated_at); DROP TABLE sessions;');
  db.close();
  assert.deepEqual(bootstrap(f), []);
});

test('a fresh database never gets the old tables, and logs nothing', () => {
  const f = path.join(dir, 'fresh.db');
  assert.deepEqual(bootstrap(f), []);
  const tables = names(f, 'table');
  assert.ok(!tables.includes('sessions') && !tables.includes('lineage'));
  assert.ok(tables.includes('events') && tables.includes('agent_sessions'));
  assert.deepEqual(names(f, 'index').filter((n) => n.startsWith('idx_sessions')), []);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
