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

const T = { firstWindowMs: 600, extraWindowMs: 300, checkEveryMs: 100, versionRetryMs: 1 };

function deps(readyAfterCalls, over = {}) {
  const calls = [];
  let waits = 0;
  return {
    calls,
    deps: {
      waitReady: async () => { waits++; calls.push(`wait${waits}`); return waits >= readyAfterCalls; },
      runningVersion: async () => '2026.9.9',
      containerState: async () => ({ running: true, status: 'running', restartCount: 0 }),
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

await test('container gone or exited during the extra wait: stops early with a clear, non-eligible error', async () => {
  for (const [state, text] of [[null, /container is gone/], [{ running: false, status: 'exited', restartCount: 0 }, /container exited/]]) {
    const d = deps(99, { containerState: async () => state });
    await assert.rejects(m.finishAfterRecreate(d.deps, '2026.9.9', T), text);
    assert.equal(d.calls.filter((c) => c.startsWith('wait')).length, 1, 'no extra wait');
    assert.ok(!d.calls.includes('slow'));
  }
  const err = 'The agent container exited before OpenClaw 2026.9.9 finished starting (state: exited)';
  assert.equal(m.isEligibleForResolution('failed', null, err), false);
});
await test('a restarting container is still waited for; 3 restarts since the recreate stop the wait', async () => {
  let n = 0;
  const waiting = deps(3, { containerState: async () => ({ running: false, status: 'restarting', restartCount: 2 }) });
  await m.finishAfterRecreate(waiting.deps, '2026.9.9', T);
  const looping = deps(99, { containerState: async () => ({ running: true, status: 'running', restartCount: n++ === 0 ? 1 : 4 }) });
  await assert.rejects(m.finishAfterRecreate(looping.deps, '2026.9.9', T), /keeps restarting \(3 restarts/);
  assert.equal(looping.calls.filter((c) => c.startsWith('wait')).length, 1);
  assert.equal(m.isEligibleForResolution('failed', null, 'The gateway keeps restarting (3 restarts since the update), so OpenClaw 2026.9.9 will not finish starting'), false);
});
await test('an uninspectable container does not stop the wait', async () => {
  const d = deps(3, { containerState: async () => { throw new Error('docker down'); } });
  await m.finishAfterRecreate(d.deps, '2026.9.9', T);
  assert.ok(d.calls.includes('verify'));
});
await test('a null version right after ready is retried up to 3 times; a different version fails at once', async () => {
  let reads = 0;
  const ok = deps(1, { runningVersion: async () => (++reads < 3 ? null : '2026.9.9') });
  await m.finishAfterRecreate(ok.deps, '2026.9.9', T);
  assert.equal(reads, 3);
  assert.ok(ok.calls.includes('verify'));
  reads = 0;
  const never = deps(1, { runningVersion: async () => { reads++; return null; } });
  await assert.rejects(m.finishAfterRecreate(never.deps, '2026.9.9', T), /reports no version/);
  assert.equal(reads, 4);
  reads = 0;
  const other = deps(1, { runningVersion: async () => { reads++; return '2026.9.3'; } });
  await assert.rejects(m.finishAfterRecreate(other.deps, '2026.9.9', T), /2026\.9\.3 instead/);
  assert.equal(reads, 1);
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
await test('resolved failure of the latest update offers Roll back anyway, not the plain Roll back', async () => {
  const r = row('failed', { resolvedAtMs: 5 });
  assert.equal(m.offersRollbackAnyway(r, false), true);
  assert.equal(m.offersRollbackAnyway(r, true), false);
  assert.equal(m.offersRollbackAnyway(row('failed'), false), false);
  assert.equal(m.offersRollbackAnyway(row('done'), false), false);
  assert.equal(m.offersRollbackAnyway(row('failed', { resolvedAtMs: 5, backupFile: null }), false), false);
});
await test('an interrupted rollback is never a resolved failure, even with a stale resolved_at', async () => {
  const r = row('interrupted', { resolvedAtMs: 5, error: 'Rev4a restarted while this step was running: rolling_back' });
  assert.equal(m.isResolvedFailure(r), false);
  assert.equal(m.showsRedFailure(r), true);
  assert.equal(m.offersRollback(r, false), true);
  assert.equal(m.offersRollbackAnyway(r, false), false);
});
await test('a deleted pre-update backup hides both rollbacks and shows the muted line; unknown keeps them', async () => {
  for (const r of [row('done'), row('failed'), row('failed', { resolvedAtMs: 5 })]) {
    const gone = { ...r, backupAvailable: false };
    assert.equal(m.offersRollback(gone, false), false);
    assert.equal(m.offersRollbackAnyway(gone, false), false);
    assert.equal(m.backupWasDeleted(gone, false), true);
    for (const known of [true, null, undefined]) {
      const ok = { ...r, backupAvailable: known };
      assert.equal(m.backupWasDeleted(ok, false), false);
      assert.equal(m.offersRollback(ok, false) || m.offersRollbackAnyway(ok, false), true);
    }
  }
  assert.equal(m.backupWasDeleted({ ...row('done'), backupAvailable: false }, true), false, 'no line while active');
  assert.equal(m.backupWasDeleted({ ...row('rolled_back'), backupAvailable: false }, false), false);
});
await test('whenEligible runs no container work for a row that can never be resolved', async () => {
  let calls = 0;
  const gather = async () => { calls++; return 'x'; };
  for (const r of [
    { status: 'failed', verify_json: '{"ok":true}', error: 'OpenClaw 2026.9.9 did not finish starting within 40 minutes' },
    { status: 'failed', verify_json: null, error: 'The pre-update backup failed: x' },
    { status: 'interrupted', verify_json: null, error: 'Rev4a restarted while this step was running: rolling_back' },
    { status: 'done', verify_json: null, error: null },
  ]) assert.equal(await m.whenEligible(r, gather), null);
  assert.equal(calls, 0);
  assert.equal(await m.whenEligible({ status: 'failed', verify_json: null, error: 'OpenClaw 2026.9.9 did not finish starting within 40 minutes' }, gather), 'x');
  assert.equal(calls, 1);
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
  assert.equal(m.resolutionText('failed', '2026.9.9', { kind: 'recreate', atMs: at }), 'verified on 2026.9.9 after a slow start (the agent was recreated on 2026-10-23 UTC)');
  assert.equal(m.resolutionText('interrupted', '2026.9.9', { kind: 'restore', atMs: at }), 'verified on 2026.9.9 after Rev4a restarted during the update (the agent was restored on 2026-10-23 UTC)');
  assert.equal(m.resolutionText('failed', '2026.9.9', null, "Rev4a's config could not be re-applied: boom"), "verified on 2026.9.9 after a slow start; Rev4a's config could not be re-applied: boom");
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
await test('markInterrupted keeps the real step: a slow-start note only survives for a migrating row', async () => {
  const mig = add('migrating', 'OpenClaw 2026.9.9 is still starting after 10 minutes; Rev4a keeps waiting');
  const ver = add('verifying', null); // onVerifying clears the note, so a verifying row has no error
  for (const [id, step] of [[mig, 'migrating'], [ver, 'verifying']]) {
    db.prepare("UPDATE agent_upgrades SET error = COALESCE(error, 'Rev4a restarted while this step was running: ' || status), status = 'interrupted' WHERE id = ?").run(id);
  }
  m.clearStaleSlowStartNote(db);
  assert.equal(get(mig).error, 'Rev4a restarted while this step was running: migrating');
  assert.equal(get(ver).error, 'Rev4a restarted while this step was running: verifying');
});
await test('clearing the resolution columns (a rollback start) really nulls them', async () => {
  const id = add('failed', 'OpenClaw 2026.9.9 did not finish starting within 40 minutes');
  assert.equal(m.markResolvedSql(db, id, 'r', '{}', 5), true);
  assert.equal(get(id).resolved_at, 5);
  db.prepare("UPDATE agent_upgrades SET status = 'rolling_back', error = NULL, resolved_at = NULL, resolution = NULL WHERE id = ?").run(id);
  db.prepare("UPDATE agent_upgrades SET error = COALESCE(error, 'Rev4a restarted while this step was running: ' || status), status = 'interrupted' WHERE id = ?").run(id);
  const r = get(id);
  assert.equal(r.resolved_at, null);
  assert.equal(r.resolution, null);
  assert.equal(m.isResolvedFailure({ status: r.status, resolvedAtMs: r.resolved_at, backupFile: 'b', fromVersion: '1', error: r.error }), false);
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
