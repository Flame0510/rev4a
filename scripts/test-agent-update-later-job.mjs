#!/usr/bin/env node
/**
 * Tests for lib/agent-update-later-job.ts (a recreate or restore after a failed update, shown as a
 * warning next to its Roll back).
 *
 *   node scripts/test-agent-update-later-job.mjs
 */
import assert from 'node:assert/strict';

const m = await import('../lib/agent-update-later-job.ts');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

const upd = (status, extra = {}) => ({ status, finished_at: 1000, updated_at: 900, ...extra });
const job = (status, finished_at) => ({ status, finished_at });

test('failed with a later recreate done', () => {
  assert.deepEqual(m.laterJob(upd('failed'), job('done', 2000), null), { kind: 'recreate', atMs: 2000 });
});
test('interrupted with a later restore done', () => {
  assert.deepEqual(m.laterJob(upd('interrupted'), null, job('done', 3000)), { kind: 'restore', atMs: 3000 });
});
test('both done after the update: the more recent one', () => {
  assert.deepEqual(m.laterJob(upd('failed'), job('done', 2000), job('done', 3000)), { kind: 'restore', atMs: 3000 });
  assert.deepEqual(m.laterJob(upd('failed'), job('done', 4000), job('done', 3000)), { kind: 'recreate', atMs: 4000 });
});
test('failed with no later jobs', () => {
  assert.equal(m.laterJob(upd('failed'), null, null), null);
});
test('a later recreate that failed or was interrupted', () => {
  assert.equal(m.laterJob(upd('failed'), job('failed', 2000), null), null);
  assert.equal(m.laterJob(upd('failed'), job('interrupted', 2000), null), null);
});
test('a job done at exactly the end time does not count, 1 ms later does', () => {
  assert.equal(m.laterJob(upd('failed'), job('done', 1000), null), null);
  assert.deepEqual(m.laterJob(upd('failed'), job('done', 1001), null), { kind: 'recreate', atMs: 1001 });
});
test('a job done before the update ended', () => {
  assert.equal(m.laterJob(upd('failed'), job('done', 500), job('done', 600)), null);
});
test('done, rolled_back, rollback_failed and active updates get no note', () => {
  for (const s of ['done', 'rolled_back', 'rollback_failed', 'pending', 'migrating', 'rolling_back']) {
    assert.equal(m.laterJob(upd(s), job('done', 2000), job('done', 2000)), null, s);
  }
});
test('finished_at null falls back to updated_at', () => {
  const u = upd('failed', { finished_at: null, updated_at: 900 });
  assert.deepEqual(m.laterJob(u, job('done', 950), null), { kind: 'recreate', atMs: 950 });
  assert.equal(m.laterJob(u, job('done', 850), null), null);
});
test('a done job without a numeric finished_at is no evidence', () => {
  assert.equal(m.laterJob(upd('failed'), job('done', null), null), null);
  assert.equal(m.laterJob(upd('failed'), job('done', '2000'), null), null);
});

console.log(`${passed} passed`);
