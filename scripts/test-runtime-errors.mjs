#!/usr/bin/env node
/**
 * Tests for lib/runtime-errors.ts — the count behind the System Health
 * `runtime.errors24h` check. An in-memory SQLite database, a handful of rows, no
 * network and no real database. Run it with
 *
 *   node scripts/test-runtime-errors.mjs
 *
 * and it exits non-zero on failure. The helper is TypeScript, which Node runs
 * directly (type stripping).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { countFailureEvents, FAILURE_EVENT_TYPES } from '../lib/runtime-errors.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const SINCE = NOW - DAY;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

function mkdb(kind = 'events') {
  const db = new Database(':memory:');
  if (kind === 'events') {
    db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT)`);
  } else if (kind === 'events-with-event') {
    db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      session_id TEXT NOT NULL, event TEXT, data TEXT)`);
  } else {
    db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY)');
  }
  return db;
}

function fill(db, rows) {
  const ins = db.prepare('INSERT INTO events (ts, session_id, type) VALUES (?, ?, ?)');
  db.transaction(() => { for (const [ts, type] of rows) ins.run(ts, 's', type); })();
}

test('FAILURE_EVENT_TYPES are exactly fail and spawn_timeout', () =>
  assert.deepEqual([...FAILURE_EVENT_TYPES], ['fail', 'spawn_timeout']));
test('missing events table returns 0', () =>
  assert.equal(countFailureEvents(mkdb('sessions'), SINCE), 0));
test('events table without a type column returns 0', () =>
  assert.equal(countFailureEvents(mkdb('events-with-event'), SINCE), 0));
test('empty events table returns 0', () =>
  assert.equal(countFailureEvents(mkdb(), SINCE), 0));
test('counts fail and spawn_timeout inside the window', () => {
  const db = mkdb();
  fill(db, [[NOW, 'fail'], [NOW - HOUR, 'spawn_timeout'], [NOW - 2 * HOUR, 'fail']]);
  assert.equal(countFailureEvents(db, SINCE), 3);
});
test('ignores other event types the daemon writes', () => {
  const db = mkdb();
  fill(db, [[NOW, 'spawn'], [NOW, 'complete'], [NOW, 'error'], [NOW, 'failed']]);
  assert.equal(countFailureEvents(db, SINCE), 0);
});
test('type match is case-sensitive', () => {
  const db = mkdb();
  fill(db, [[NOW, 'FAIL'], [NOW, 'Fail'], [NOW, 'SPAWN_TIMEOUT'], [NOW, 'fail']]);
  assert.equal(countFailureEvents(db, SINCE), 1);
});
test('rows before the cutoff are left out', () => {
  const db = mkdb();
  fill(db, [[SINCE - 1, 'fail'], [SINCE, 'fail'], [NOW, 'fail']]);
  assert.equal(countFailureEvents(db, SINCE), 2);
});
test('returns a plain JS number', () => {
  const db = mkdb();
  fill(db, [[NOW, 'fail']]);
  const n = countFailureEvents(db, SINCE);
  assert.equal(typeof n, 'number');
  assert.equal(n, 1);
});

if (failed) { console.log(`${failed} case(s) failed`); process.exit(1); }
console.log('all cases passed');
