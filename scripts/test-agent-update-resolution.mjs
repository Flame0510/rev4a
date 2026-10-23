#!/usr/bin/env node
/**
 * Tests for lib/agent-update-resolution.ts: a slow start finishes the update, a failed update is resolved
 * only with evidence, and the panel mapping hides the rollback of a resolved failure.
 *
 *   node scripts/test-agent-update-resolution.mjs
 */
import assert from 'node:assert/strict';

const m = await import('../lib/agent-update-resolution.ts');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

// ── Slow start ────────────────────────────────────────────────────────────────

const T = { firstWindowMs: 600, extraWindowMs: 300, checkEveryMs: 100 };

function deps(readyAfterCalls, over = {}) {
  const calls = [];
  let waits = 0;
  return {
    calls,
    deps: {
      waitReady: async () => { waits++; calls.push(`wait${waits}`); return waits >= readyAfterCalls; },
      runningVersion: async () => '2026.9.9',
      onSlowStart: () => calls.push('slow'),
      applyConfig: async () => { calls.push('apply'); },
      onVerifying: () => calls.push('verifying'),
      verify: async () => { calls.push('verify'); },
      ...over,
    },
  };
}

await test('ready in the first window: no slow-start note, remaining steps run in order', async () => {
  const d = deps(1);
  await m.finishAfterRecreate(d.deps, '2026.9.9', T);
  assert.deepEqual(d.calls, ['wait1', 'apply', 'verifying', 'verify']);
});

await test('ready after the first timeout: noted, then the remaining steps run', async () => {
  const d = deps(3);
  await m.finishAfterRecreate(d.deps, '2026.9.9', T);
  assert.deepEqual(d.calls, ['wait1', 'slow', 'wait2', 'wait3', 'apply', 'verifying', 'verify']);
});

await test('never ready: fails after the extra window, nothing else runs', async () => {
  const d = deps(99);
  await assert.rejects(m.finishAfterRecreate(d.deps, '2026.9.9', T), /did not finish starting/);
  assert.equal(d.calls.filter((c) => c.startsWith('wait')).length, 1 + 3);
  assert.ok(!d.calls.includes('apply') && !d.calls.includes('verify'));
});

await test('ready on another version: fails before the config is applied', async () => {
  const d = deps(1, { runningVersion: async () => '2026.9.3' });
  await assert.rejects(m.finishAfterRecreate(d.deps, '2026.9.9', T), /2026\.9\.3 instead of 2026\.9\.9/);
  assert.ok(!d.calls.includes('apply'));
});

await test('verification failure after a slow start: the error reaches the caller (failed)', async () => {
  const d = deps(2, { verify: async () => { throw new Error('1 session(s) have fewer transcript events than before the update'); } });
  await assert.rejects(m.finishAfterRecreate(d.deps, '2026.9.9', T), /fewer transcript events/);
  assert.ok(d.calls.includes('verifying'));
});

// ── Resolution ────────────────────────────────────────────────────────────────

const base = {
  status: 'failed',
  resolvedAt: null,
  toVersion: '2026.9.9',
  containerRunning: true,
  gatewayReady: true,
  runningVersion: '2026.9.9',
  verifyJson: null,
  error: 'OpenClaw 2026.9.9 did not finish starting within 10 minutes',
  hasBaseline: true,
  cronUnreadable: false,
  verificationOk: true,
};
const ev = (over) => m.evaluateResolution({ ...base, ...over });

await test('on the target version, ready and verified: resolved (failed and interrupted)', async () => {
  assert.deepEqual(ev({}), { resolved: true });
  assert.deepEqual(ev({ status: 'interrupted', error: 'Rev4a restarted while this step was running: migrating' }), { resolved: true });
});
await test('wrong version: unresolved', async () => {
  assert.equal(ev({ runningVersion: '2026.9.3' }).resolved, false);
  assert.equal(ev({ runningVersion: null }).resolved, false);
});
await test('verification fails or did not run: unresolved', async () => {
  assert.equal(ev({ verificationOk: false }).resolved, false);
  assert.equal(ev({ verificationOk: null }).resolved, false);
});
await test('cron list unreadable: unresolved', async () => {
  assert.equal(ev({ cronUnreadable: true }).resolved, false);
});
await test('not running or gateway not ready: unresolved', async () => {
  assert.equal(ev({ containerRunning: false }).resolved, false);
  assert.equal(ev({ gatewayReady: false }).resolved, false);
});
await test('no stored baseline: unresolved (nothing to verify against)', async () => {
  assert.equal(ev({ hasBaseline: false }).resolved, false);
});
await test('done, rolled back and already resolved rows are left alone', async () => {
  for (const status of ['done', 'rolled_back', 'rollback_failed', 'migrating']) assert.equal(ev({ status }).resolved, false);
  assert.equal(ev({ resolvedAt: 1 }).resolved, false);
});

await test('re-check is due at most every 5 minutes', async () => {
  assert.equal(m.dueForRecheck(undefined, 1000), true);
  assert.equal(m.dueForRecheck(1000, 1000 + 4 * 60_000), false);
  assert.equal(m.dueForRecheck(1000, 1000 + 5 * 60_000), true);
});

// ── Panel mapping ─────────────────────────────────────────────────────────────

const row = (status, over = {}) => ({ status, resolvedAtMs: null, backupFile: 'b.tar.gz', fromVersion: '2026.9.3', ...over });

await test('unresolved failure: red and rollback offered', async () => {
  for (const status of ['failed', 'interrupted']) {
    assert.equal(m.showsRedFailure(row(status)), true);
    assert.equal(m.offersRollback(row(status), false), true);
  }
});
await test('resolved failure: not red, no rollback in the status area', async () => {
  const r = row('failed', { resolvedAtMs: 5 });
  assert.equal(m.isResolvedFailure(r), true);
  assert.equal(m.showsRedFailure(r), false);
  assert.equal(m.offersRollback(r, false), false);
});
await test('done keeps its rollback; active hides it; missing backup hides it', async () => {
  assert.equal(m.offersRollback(row('done'), false), true);
  assert.equal(m.offersRollback(row('done'), true), false);
  assert.equal(m.offersRollback(row('failed', { backupFile: null }), false), false);
  assert.equal(m.showsRedFailure(row('done')), false);
});

// ── Eligibility, text, SQL ────────────────────────────────────────────────────

await test('a stored verification result is never erased: ok:false and ok:true both stay unresolved', async () => {
  assert.equal(ev({ verifyJson: '{"ok":false}' }).resolved, false);
  assert.equal(ev({ verifyJson: '{"ok":true}' }).resolved, false);
});
await test('a version mismatch, a failed backup or a failed verification error is never eligible', async () => {
  for (const error of [
    'The agent reports OpenClaw 2026.9.3 instead of 2026.9.9',
    'The pre-update backup failed: x',
    'The cron job list could not be read after the update, so the verification is incomplete',
    '2 session(s) have fewer transcript events than before the update',
    null,
  ]) assert.equal(ev({ error }).resolved, false, String(error));
});
await test('slow-start timeout and interruption are eligible', async () => {
  assert.equal(m.isEligibleForResolution('failed', null, 'OpenClaw 2026.9.9 did not finish starting within 40 minutes'), true);
  assert.equal(m.isEligibleForResolution('failed', null, 'OpenClaw 2026.9.9 is still starting after 10 minutes; Rev4a keeps waiting'), true);
  assert.equal(m.isEligibleForResolution('interrupted', null, 'Rev4a restarted while this step was running: migrating'), true);
  assert.equal(m.isEligibleForResolution('interrupted', '{"ok":false}', 'Rev4a restarted while this step was running: migrating'), false);
});
await test('resolution text names the real cause and a later recreate or restore', async () => {
  const at = Date.UTC(2026, 9, 23, 12);
  assert.equal(m.resolutionText('failed', '2026.9.9', null), 'verified on 2026.9.9 after a slow start');
  assert.equal(m.resolutionText('interrupted', '2026.9.9', null), 'verified on 2026.9.9 after Rev4a restarted during the update');
  assert.equal(m.resolutionText('failed', '2026.9.9', { kind: 'recreate', atMs: at }), 'verified on 2026.9.9 after a slow start (the agent was recreated on 2026-10-23)');
  assert.equal(m.resolutionText('interrupted', '2026.9.9', { kind: 'restore', atMs: at }), 'verified on 2026.9.9 after Rev4a restarted during the update (the agent was restored on 2026-10-23)');
});
await test('an unreadable cron list stores no verification result', async () => {
  assert.equal(m.verifyJsonForStore({ ok: true }, true), null);
  assert.equal(m.verifyJsonForStore({ ok: false }, false), '{"ok":false}');
});

const { createRequire } = await import('node:module');
const Database = createRequire(import.meta.url)('better-sqlite3');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { initializeRev4aDb } = await import('../lib/db-bootstrap.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-resolution-'));
const file = path.join(dir, 'events.db');
initializeRev4aDb(file);
const db = new Database(file);
const add = (status, error) => Number(db.prepare("INSERT INTO agent_upgrades (agent_id, status, to_version, error, started_at, updated_at) VALUES ('a', ?, '2026.9.9', ?, 1, 1)").run(status, error).lastInsertRowid);
const get = (id) => db.prepare('SELECT * FROM agent_upgrades WHERE id = ?').get(id);

await test('markResolvedSql stamps a failed row once and never a rolling_back one', async () => {
  const failed = add('failed', 'e');
  assert.equal(m.markResolvedSql(db, failed, 'r', '{}', 5), true);
  assert.equal(get(failed).resolved_at, 5);
  assert.equal(get(failed).status, 'failed');
  assert.equal(m.markResolvedSql(db, failed, 'again', '{}', 6), false);
  const racing = add('rolling_back', null);
  assert.equal(m.markResolvedSql(db, racing, 'r', '{}', 5), false);
  assert.equal(get(racing).resolved_at, null);
});
await test('an interrupted row loses the "keeps waiting" note, other errors stay', async () => {
  const a = add('interrupted', 'OpenClaw 2026.9.9 is still starting after 10 minutes; Rev4a keeps waiting');
  const b = add('interrupted', 'Rev4a restarted while this step was running: backing_up');
  const c = add('migrating', 'OpenClaw 2026.9.9 is still starting after 10 minutes; Rev4a keeps waiting');
  m.clearStaleSlowStartNote(db);
  assert.equal(get(a).error, 'Rev4a restarted while this step was running: migrating');
  assert.equal(get(b).error, 'Rev4a restarted while this step was running: backing_up');
  assert.match(get(c).error, /keeps waiting/);
});
db.close();
fs.rmSync(dir, { recursive: true, force: true });

await test('an interrupted rollback, an interruption without a step and an unanchored start text are never eligible', () => {
  assert.equal(m.isEligibleForResolution('interrupted', null, 'Rev4a restarted while this step was running: rolling_back'), false);
  assert.equal(m.isEligibleForResolution('interrupted', null, null), false);
  assert.equal(m.isEligibleForResolution('failed', null, 'apply failed: x did not finish starting within y'), false);
  assert.equal(m.isEligibleForResolution('interrupted', null, 'Rev4a restarted while this step was running: migrating'), true);
  assert.equal(m.isEligibleForResolution('interrupted', null, 'Rev4a restarted while this step was running: verifying'), true);
  assert.equal(m.isEligibleForResolution('failed', null, 'OpenClaw 2026.9.9 did not finish starting within 10 minutes'), true);
  assert.equal(m.isEligibleForResolution('failed', null, 'OpenClaw 2026.9.9 did not finish starting within 40 minutes'), true);
});

console.log(`\n${passed} passed`);
