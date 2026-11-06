#!/usr/bin/env node
/** Update safety: cron identity, owned retirement and conservative historical repair. No Docker. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as m from '../lib/agent-update-cron.ts';
import { isEligibleForResolution, offersRollbackAnyway } from '../lib/agent-update-resolution.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error.stack}`); process.exit(1); }
}

const transition = { fromVersion: '2026.9.9', toVersion: '2026.10.10' };
const owned = { id: 'owned', name: 'skill-collection-review-main', declarationKey: 'skill-collection-review:main', agentId: 'main' };
const user = { id: 'user', name: 'weekly-report', declarationKey: null, agentId: null };
const heartbeat = { id: 'heartbeat', name: 'heartbeat-main', declarationKey: 'heartbeat:main', agentId: 'main' };
const before = [owned, user, heartbeat];
const transcripts = { 'main/session': 12 };
const baseline = (jobs = before) => ({ transcripts, cronJobs: m.cronNames(jobs), cronBaselineVersion: 1, cronJobIdentities: jobs });
const legacy = (jobs = before) => ({ transcripts, cronJobs: m.cronNames(jobs) });
const verify = (jobs, base = baseline(), move = transition, counts = transcripts) => m.verifyUpdateBaseline(base, counts, jobs, move);

test('plain and jobs-envelope output retain native identity and ownership', () => {
  assert.deepEqual(m.parseCronListForUpdate(JSON.stringify(before)), before);
  assert.deepEqual(m.parseCronListForUpdate(`notice\n${JSON.stringify({ jobs: before })}`), before);
});
test('a valid empty list is distinct from unreadable and invalid envelopes', () => {
  assert.deepEqual(m.parseCronListForUpdate('[]'), []);
  assert.deepEqual(m.parseCronListForUpdate('{"jobs":[]}'), []);
  for (const text of ['', 'null', '{}', '{"jobs":null}', '{"jobs":{}}', '[1]', '{', '{"jobs":[{"name":"no-id"}]}']) {
    assert.equal(m.parseCronListForUpdate(text), null, text);
  }
});
test('duplicate IDs and malformed optional ownership never become a successful partial list', () => {
  for (const jobs of [[user, user], [user, null], [{ ...owned, declarationKey: 3 }], [{ ...user, name: '' }]]) {
    assert.equal(m.parseCronJobIdentities(jobs), null);
  }
});
test('explicit errors, partial pages and inconsistent totals cannot become complete cron lists', () => {
  for (const envelope of [
    { jobs: [], ok: false }, { jobs: [], success: false }, { jobs: [], error: 'unavailable' },
    { jobs: [], hasMore: true, nextOffset: 1, total: 5 }, { jobs: [], total: 1 },
    { jobs: [], totalCount: 5 }, { jobs: [], offset: 1 }, { jobs: [], nextOffset: 0 },
    { jobs: [], truncated: true }, { jobs: [], partial: true }, { jobs: [], total: -1 },
  ]) assert.equal(m.parseCronJobIdentities(envelope), null);
  assert.deepEqual(m.parseCronJobIdentities({ jobs: [], ok: true, error: null, total: 0, hasMore: false, offset: 0, nextOffset: null }), []);
});
test('a surviving identity moved to another agent is not preserved ownership', () => {
  const explicit = { ...user, agentId: 'main' };
  const result = verify([{ ...explicit, agentId: 'other' }], baseline([explicit]));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingCronJobs, [explicit.name]);
});
test('same names on distinct user identities are legal and preserved', () => {
  const jobs = [user, { ...user, id: 'user-two' }];
  assert.equal(m.parseCronJobIdentities(jobs).length, 2);
  assert.equal(verify(jobs, baseline(jobs)).ok, true);
  assert.equal(verify([user], baseline(jobs)).ok, false);
});
test('retirement is accepted only on the two evaluated source-to-target transitions', () => {
  for (const fromVersion of ['2026.9.3', '2026.9.9']) {
    const result = verify([user, heartbeat], baseline(), { fromVersion, toVersion: '2026.10.10' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingCronJobs, []);
    assert.deepEqual(result.retiredCronJobs, [owned.name]);
  }
});
test('unknown source, hotfix and newer target never inherit the retirement exception', () => {
  for (const move of [undefined, { fromVersion: null, toVersion: '2026.10.10' },
    { fromVersion: '2026.9.10', toVersion: '2026.10.10' }, { fromVersion: '2026.9.9-1', toVersion: '2026.10.10' },
    { fromVersion: '2026.9.9', toVersion: '2026.10.11' }, { fromVersion: '2026.10.10', toVersion: '2026.10.10' }]) {
    assert.equal(m.verifyUpdateBaseline(baseline(), transcripts, [user, heartbeat], move).ok, false);
  }
});
test('same-named user job loss still fails even when the owned job is legitimately retired', () => {
  const sameName = { ...user, name: owned.name };
  const result = verify([heartbeat], baseline([owned, sameName, heartbeat]));
  assert.equal(result.ok, false);
  assert.deepEqual(result.retiredCronJobs, [owned.name]);
  assert.deepEqual(result.missingCronJobs, [sameName.name]);
});
test('a different job with the same name cannot replace the original identity', () => {
  assert.equal(verify([owned, { ...user, id: 'replacement' }, heartbeat]).ok, false);
});
test('a renamed job retains its identity; ownership changes do not masquerade as retention', () => {
  assert.equal(verify([owned, { ...user, name: 'renamed' }, heartbeat]).ok, true);
  assert.equal(verify([{ ...owned, declarationKey: null }, user, heartbeat]).ok, false);
});
test('unrelated declared loss and malformed retired ownership fail', () => {
  assert.equal(verify([user]).ok, false);
  for (const job of [{ ...owned, declarationKey: 'skill-collection-review:' }, { ...owned, agentId: 'other' },
    { ...owned, declarationKey: null }, { ...owned, declarationKey: 'other:main' }]) {
    assert.equal(verify([user], baseline([job, user])).ok, false);
  }
});
test('retiring an owned cron never excuses lost transcript events', () => {
  const result = verify([user, heartbeat], baseline(), transition, { 'main/session': 11 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.lostEvents, [{ session: 'main/session', before: 12, after: 11 }]);
});
test('empty-to-empty verifies; unreadable before or after cannot prove preservation', () => {
  assert.equal(verify([], baseline([])).ok, true);
  assert.equal(verify(null, baseline([])).ok, false);
  assert.equal(verify([], { transcripts, cronJobs: null }).ok, false);
  assert.equal(verify([], { transcripts, cronJobs: null, cronBaselineVersion: 1, cronJobIdentities: null }).ok, false);
});
test('legacy name-only baselines remain readable without any retirement guess', () => {
  assert.deepEqual(m.readUpdateBaseline(JSON.stringify(legacy())), legacy());
  assert.equal(verify(before, legacy()).ok, true);
  assert.equal(verify([user, heartbeat], legacy()).ok, false);
});
test('legacy duplicate names require matching multiplicity', () => {
  const base = { transcripts, cronJobs: ['same', 'same'] };
  assert.equal(m.verifyUpdateBaseline(base, transcripts, ['same']).ok, false);
  assert.equal(m.verifyUpdateBaseline(base, transcripts, ['same', 'same']).ok, true);
});
test('malformed rich baselines cannot fall back to their old name list', () => {
  for (const base of [{ ...baseline(), cronJobIdentities: undefined }, { ...baseline(), cronBaselineVersion: 2 },
    { ...baseline(), cronJobIdentities: [] }, { ...baseline(), cronJobIdentities: [user, user] },
    { ...legacy(), cronJobIdentities: before }, { ...legacy(), transcripts: { s: -1 } }, { ...legacy(), cronJobs: {} }]) {
    assert.equal(m.parseUpdateBaseline(base), null);
    assert.equal(verify(before, base).ok, false);
  }
});
test('string-only after output cannot satisfy a rich identity baseline', () => {
  assert.equal(verify(m.cronNames(before)).ok, false);
});

const originalVerification = JSON.stringify({ sessions: 1, lostEvents: [], missingCronJobs: [owned.name], ok: false });
const row = (over = {}) => ({ id: 1, agent_id: 'agent_audit', status: 'failed', from_version: '2026.9.9', to_version: '2026.10.10',
  backup_file: 'agent-audit-preupdate.tar.gz', baseline_json: JSON.stringify(legacy()), verify_json: originalVerification,
  error: `Cron jobs missing after the update: ${owned.name}`, resolved_at: null, cron_repair_json: null, ...over });
const evidence = (over = {}) => ({ kind: 'verified', file: row().backup_file, sha256: 'a'.repeat(64), jobs: before, ...over });

test('a recorded cron-only failure enters a separate audit, not generic slow-start resolution', () => {
  assert.equal(m.isCronRepairCandidate(row()), true);
  assert.equal(isEligibleForResolution('failed', originalVerification, row().error), false);
});
test('rollback/interrupted/done rows and non-cron failures never enter repair', () => {
  for (const over of [{ status: 'rollback_failed' }, { status: 'rolling_back' }, { status: 'interrupted' }, { status: 'done' },
    { resolved_at: 1 }, { from_version: '2026.9.10' }, { backup_file: null }, { verify_json: null },
    { verify_json: 'bad' }, { baseline_json: '{}' }, { error: 'a prefix: Cron jobs missing after the update: x' },
    { verify_json: JSON.stringify({ lostEvents: [{ session: 's' }], missingCronJobs: [owned.name], ok: false }) }]) {
    assert.equal(m.isCronRepairCandidate(row(over)), false, JSON.stringify(over));
  }
});
test('complete matching archived identities can enrich an old baseline', () => {
  assert.deepEqual(m.baselineWithCronEvidence(row(), evidence()), baseline());
  assert.equal(verify([user, heartbeat], m.baselineWithCronEvidence(row(), evidence())).ok, true);
});
test('missing/untrusted backup evidence cannot establish legacy ownership', () => {
  for (const proof of [{ kind: 'unavailable', reason: 'missing archive' }, evidence({ file: 'other.tar.gz' }),
    evidence({ sha256: 'bad' }), evidence({ jobs: [owned, user] }), evidence({ jobs: [owned, user, user] }),
    evidence({ jobs: [{ ...owned, name: 'different' }, user, heartbeat] })]) {
    assert.equal(m.baselineWithCronEvidence(row(), proof), null);
  }
});
test('archived same-name user duplicates remain visible to identity verification', () => {
  const sameNameUser = { ...user, name: owned.name };
  const old = row({ baseline_json: JSON.stringify(legacy([owned, sameNameUser])) });
  const enriched = m.baselineWithCronEvidence(old, evidence({ jobs: [owned, sameNameUser] }));
  assert.equal(verify([], enriched).ok, false);
});
test('rich archived identities tolerate reordered rows but reject changed ownership', () => {
  const old = row({ baseline_json: JSON.stringify(baseline()) });
  assert.notEqual(m.baselineWithCronEvidence(old, evidence({ jobs: [...before].reverse() })), null);
  assert.equal(m.baselineWithCronEvidence(old, evidence({ jobs: [{ ...owned, declarationKey: null }, user, heartbeat] })), null);
});

const db = new Database(':memory:');
db.exec(`CREATE TABLE agent_upgrades (id INTEGER PRIMARY KEY, agent_id TEXT, status TEXT, from_version TEXT, to_version TEXT,
  backup_file TEXT, baseline_json TEXT, verify_json TEXT, error TEXT, started_at INTEGER, updated_at INTEGER, finished_at INTEGER,
  resolved_at INTEGER, resolution TEXT, cron_repair_json TEXT);
CREATE TABLE agent_restores (agent_id TEXT, finished_at INTEGER);
CREATE TABLE agent_recreates (agent_id TEXT, finished_at INTEGER);
CREATE TABLE agent_edits (agent_id TEXT, finished_at INTEGER);`);
const insert = (over = {}) => {
  const r = row(over);
  db.prepare(`INSERT INTO agent_upgrades (id,agent_id,status,from_version,to_version,backup_file,baseline_json,verify_json,error,
    started_at,updated_at,finished_at,resolved_at,cron_repair_json) VALUES (?,?,?,?,?,?,?,?,?,10,20,30,?,?)`)
    .run(r.id, r.agent_id, r.status, r.from_version, r.to_version, r.backup_file, r.baseline_json, r.verify_json, r.error, r.resolved_at, r.cron_repair_json);
  return db.prepare('SELECT * FROM agent_upgrades WHERE id=?').get(r.id);
};
const get = (id) => db.prepare('SELECT * FROM agent_upgrades WHERE id=?').get(id);
const goodAudit = { version: 1, policy: 'retired-skill-collection-review-v1', status: 'verified', reason: 'Proven owned retirement',
  checkedAtMs: 50, source: { file: row().backup_file, sha256: 'a'.repeat(64) }, verification: verify([user, heartbeat]) };
const unknownAudit = { version: 1, policy: goodAudit.policy, status: 'unresolved', reason: 'No trustworthy ownership evidence', checkedAtMs: 50 };

test('a proven repair preserves every original failure and verification byte', () => {
  const old = insert();
  assert.equal(m.recordCronRepairAuditSql(db, old, goodAudit), true);
  const repaired = get(old.id);
  for (const key of ['status', 'error', 'finished_at', 'started_at', 'updated_at', 'baseline_json', 'verify_json', 'backup_file']) {
    assert.equal(repaired[key], old[key], key);
  }
  assert.equal(repaired.resolved_at, 50);
  assert.equal(m.readCronRepairAudit(repaired.cron_repair_json).status, 'verified');
  assert.equal(offersRollbackAnyway({ status: repaired.status, resolvedAtMs: repaired.resolved_at, backupFile: repaired.backup_file, fromVersion: repaired.from_version }, false), true);
  assert.equal(m.recordCronRepairAuditSql(db, old, { ...goodAudit, checkedAtMs: 99 }), false);
});
test('unavailable evidence writes an unresolved diagnosis once without changing failure/rollback', () => {
  const old = insert({ id: 2, agent_id: 'unknown' });
  assert.equal(m.recordCronRepairAuditSql(db, old, unknownAudit), true);
  const audited = get(old.id);
  assert.equal(audited.resolved_at, null);
  assert.equal(audited.resolution, null);
  assert.equal(audited.verify_json, old.verify_json);
  assert.equal(m.recordCronRepairAuditSql(db, audited, { ...unknownAudit, checkedAtMs: 99 }), false);
  assert.equal(get(old.id).cron_repair_json, audited.cron_repair_json);
});
test('a rollback that starts during the audit wins the compare-and-set', () => {
  const old = insert({ id: 3, agent_id: 'rollback' });
  db.prepare("UPDATE agent_upgrades SET status='rolling_back' WHERE id=?").run(old.id);
  assert.equal(m.recordCronRepairAuditSql(db, old, goodAudit), false);
  assert.equal(get(old.id).cron_repair_json, null);
});
test('a newer update cannot be hidden by a stale repair', () => {
  const old = insert({ id: 4, agent_id: 'newer' });
  insert({ id: 5, agent_id: 'newer', status: 'pending' });
  assert.equal(m.recordCronRepairAuditSql(db, old, goodAudit), false);
});
test('an active restore, recreate or edit blocks the final audit write', () => {
  let id = 6;
  for (const table of ['agent_restores', 'agent_recreates', 'agent_edits']) {
    const old = insert({ id: id++, agent_id: table });
    db.prepare(`INSERT INTO ${table} VALUES (?,NULL)`).run(old.agent_id);
    assert.equal(m.recordCronRepairAuditSql(db, old, goodAudit), false, table);
  }
});
test('changed original verification or ownership baseline cannot be stamped by a stale audit', () => {
  for (const [id, key] of [[9, 'verify_json'], [10, 'baseline_json'], [11, 'backup_file'], [12, 'error']]) {
    const old = insert({ id, agent_id: `changed-${id}` });
    db.prepare(`UPDATE agent_upgrades SET ${key}='changed' WHERE id=?`).run(id);
    assert.equal(m.recordCronRepairAuditSql(db, old, goodAudit), false, key);
  }
});
test('verified audit requires positive preservation/retirement and exact backup evidence', () => {
  const old = insert({ id: 13, agent_id: 'invalid-audit' });
  for (const audit of [{ ...goodAudit, source: undefined }, { ...goodAudit, source: { ...goodAudit.source, file: 'wrong' } },
    { ...goodAudit, verification: { ...goodAudit.verification, ok: false } },
    { ...goodAudit, verification: { ...goodAudit.verification, retiredCronJobs: [] } }]) {
    assert.equal(m.recordCronRepairAuditSql(db, old, audit), false);
  }
});
db.close();

console.log(`\n${passed} passed`);
