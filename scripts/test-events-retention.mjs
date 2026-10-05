import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { EVENTS_RETENTION_MS, pruneEvents } = require('../lib/events-retention.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
let failed = 0;

function mkdb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT)`);
  return db;
}
function fill(db, rows) {
  const ins = db.prepare('INSERT INTO events (ts, session_id, type) VALUES (?, ?, ?)');
  db.transaction(() => { for (const [ts, s, t] of rows) ins.run(ts, s, t || 'spawn'); })();
}
const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM events').get().n;

function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

test('constant is 30 days', () => assert.equal(EVENTS_RETENTION_MS, 30 * DAY));
test('nowMs not finite throws TypeError', () => {
  const db = mkdb();
  for (const v of [NaN, Infinity, '1', undefined, null]) {
    assert.throws(() => pruneEvents(db, v), TypeError);
  }
});
test('retentionMs invalid throws RangeError', () => {
  const db = mkdb();
  for (const v of [0, DAY - 1, -5, NaN, Infinity, '1', null]) {
    assert.throws(() => pruneEvents(db, NOW, { retentionMs: v }), RangeError);
  }
});
test('retentionMs of exactly one day is accepted', () => {
  assert.equal(pruneEvents(mkdb(), NOW, { retentionMs: DAY }), 0);
});
test('no events table returns 0', () => {
  assert.equal(pruneEvents(new Database(':memory:'), NOW), 0);
});
test('empty table returns 0', () => assert.equal(pruneEvents(mkdb(), NOW), 0));
test('deletes old, keeps the row exactly at the cutoff and newer', () => {
  const db = mkdb();
  const cutoff = NOW - EVENTS_RETENTION_MS;
  fill(db, [[cutoff - 1, 'a'], [cutoff, 'a'], [cutoff + 1, 'a'], [NOW, 'a']]);
  assert.equal(pruneEvents(db, NOW), 1);
  assert.deepEqual(db.prepare('SELECT ts FROM events ORDER BY ts').all().map((r) => r.ts),
    [cutoff, cutoff + 1, NOW]);
});
test('any type and any session_id are deleted', () => {
  const db = mkdb();
  const old = NOW - 40 * DAY;
  fill(db, [[old, 'x:cron:1', 'spawn'], [old, 'system', 'system_anomaly'], [old, 'system:agents', 'agent_created']]);
  assert.equal(pruneEvents(db, NOW), 3);
  assert.equal(count(db), 0);
});
test('custom retentionMs', () => {
  const db = mkdb();
  fill(db, [[NOW - 3 * DAY, 'a'], [NOW - DAY / 2, 'a']]);
  assert.equal(pruneEvents(db, NOW, { retentionMs: 2 * DAY }), 1);
  assert.equal(count(db), 1);
});
for (const [n, label] of [[4999, 'just under one batch'], [5000, 'exactly one batch'], [5001, 'one batch plus one'], [12345, 'several batches']]) {
  test(`${n} old rows (${label}) all deleted, recent kept`, () => {
    const db = mkdb();
    const old = NOW - 31 * DAY;
    fill(db, Array.from({ length: n }, () => [old, 's']).concat([[NOW, 's'], [NOW - DAY, 's']]));
    assert.equal(pruneEvents(db, NOW), n);
    assert.equal(count(db), 2);
  });
}
test('each statement deletes at most 5000 rows', () => {
  const db = mkdb();
  fill(db, Array.from({ length: 12000 }, () => [NOW - 31 * DAY, 's']));
  const sizes = [];
  const wrapped = {
    prepare(sql) {
      const st = db.prepare(sql);
      if (!/^DELETE/.test(sql)) return st;
      return { run: (...a) => { const r = st.run(...a); sizes.push(r.changes); return r; } };
    },
  };
  assert.equal(pruneEvents(wrapped, NOW), 12000);
  assert.deepEqual(sizes, [5000, 5000, 2000]);
});

if (failed) { console.log(`${failed} case(s) failed`); process.exit(1); }
console.log('all cases passed');
