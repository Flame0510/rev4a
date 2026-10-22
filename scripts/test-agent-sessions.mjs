#!/usr/bin/env node
/**
 * Tests for lib/agent-sessions.js: row mapping, the diff against the stored row, the events it
 * writes, garbled answers, paging, and the table DDL (run twice, in memory).
 *
 *   node scripts/test-agent-sessions.mjs
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import s from '../lib/agent-sessions.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

const NOW = 1_800_000_000_000;
const ctx = { container: 'c1', agentName: 'Atlas' };
const raw = (over = {}) => ({
  key: 'agent:main:main', sessionId: 'sid1', classification: 'main', status: 'running', startedAt: NOW - 1000,
  updatedAt: NOW - 500, inputTokens: 10, outputTokens: 5, totalTokens: 15, model: 'm', modelProvider: 'p',
  estimatedCostUsd: null, ...over,
});
const stored = (rows) => new Map(rows.map((r) => [r.session_key, r]));
const row = (over = {}) => ({ ...s.mapListRow(raw(), ctx), last_seen_at: NOW - 60_000, gone_at: null, ...over });

await test('DDL runs twice and seeds one meta row', () => {
  const db = new Database(':memory:');
  db.exec(s.CREATE_TABLES_SQL); db.exec(s.CREATE_TABLES_SQL);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_sessions_meta').get().n, 1);
  const cols = db.prepare('PRAGMA table_info(agent_sessions)').all().map((c) => c.name);
  assert.deepEqual([...cols].sort(), [...s.ALL_COLUMNS].sort());
});

await test('mapListRow maps fields; unknown cost stays null, not 0', () => {
  const r = s.mapListRow(raw({ displayName: 'Dash' }), ctx);
  assert.equal(r.kind, 'main'); assert.equal(r.cost_usd, null); assert.equal(r.provider, 'p');
  assert.equal(r.label, 'Dash'); assert.equal(r.agent_name, 'Atlas');
  assert.equal(s.mapListRow(raw({ estimatedCostUsd: 0.5 }), ctx).cost_usd, 0.5);
});

await test('spawnedBy is real lineage; parentSessionKey alone is navigation', () => {
  const child = s.mapListRow(raw({ key: 'agent:main:subagent:u1', classification: 'subagent', spawnedBy: 'agent:main:main', parentSessionKey: 'agent:main:main', spawnDepth: 1 }), ctx);
  assert.equal(child.parent_kind, 'spawn'); assert.equal(child.parent_key, 'agent:main:main'); assert.equal(child.spawn_depth, 1);
  const nav = s.mapListRow(raw({ key: 'agent:main:dashboard:x', parentSessionKey: 'agent:main:main', spawnDepth: 0 }), ctx);
  assert.equal(nav.parent_kind, 'nav');
});

await test('only the main OpenClaw agent is kept; no key, no row', () => {
  assert.equal(s.mapListRow(raw({ key: 'agent:other:main' }), ctx), null);
  assert.equal(s.mapListRow({ sessionId: 'x' }, ctx), null);
});

await test('status: aborted, active run, failed, done', () => {
  assert.equal(s.mapListRow(raw({ status: 'done', abortedLastRun: true }), ctx).status, 'aborted');
  assert.equal(s.mapListRow(raw({ status: 'done', hasActiveRun: true }), ctx).status, 'running');
  assert.equal(s.mapListRow(raw({ status: 'failed' }), ctx).status, 'failed');
  assert.equal(s.mapListRow(raw({ status: undefined }), ctx).status, '');
});

await test('cron job id comes from the key', () => {
  assert.equal(s.cronJobIdOf('agent:main:cron:j1'), 'j1');
  assert.equal(s.cronJobIdOf('agent:main:cron:j1:run:s1'), 'j1');
  assert.equal(s.cronJobIdOf('agent:main:main'), null);
  assert.equal(s.cronRootJobId('agent:main:cron:j1:run:s1'), null);
});

await test('a new fresh session writes session_started; spawn adds subagent_spawned', () => {
  const next = s.mapListRow(raw({ key: 'agent:main:subagent:u1', classification: 'subagent', spawnedBy: 'agent:main:main' }), ctx);
  const d = s.diffSessions(stored([]), [next], NOW, { complete: true });
  assert.deepEqual(d.events.map((e) => e.type), ['session_started', 'subagent_spawned']);
  assert.equal(d.events[1].data.parent_key, 'agent:main:main');
  assert.equal(d.events[0].data.container, 'c1');
  assert.equal(d.events[0].session_key, 'agent:main:subagent:u1');
  assert.ok(d.changed);
});

await test('a new OLD session (found, not seen starting) writes nothing', () => {
  const old = s.mapListRow(raw({ startedAt: NOW - 86_400_000, updatedAt: NOW - 86_000_000, status: 'done' }), ctx);
  assert.deepEqual(s.diffSessions(stored([]), [old], NOW, { complete: true }).events, []);
});

await test('restart: the same data against the stored rows writes no event and no change', () => {
  const r = row();
  const d = s.diffSessions(stored([r]), [s.mapListRow(raw(), ctx)], NOW, { complete: true });
  assert.deepEqual(d.events, []); assert.equal(d.changed, false); assert.equal(d.rows[0].changed, false);
});

await test('running -> done / failed / aborted write one end event each, once', () => {
  for (const [st, type, extra] of [['done', 'session_ended', {}], ['failed', 'session_failed', { lastRunError: 'boom' }], ['done', 'session_aborted', { abortedLastRun: true }]]) {
    const next = s.mapListRow(raw({ status: st, endedAt: NOW - 10, ...extra }), ctx);
    const d = s.diffSessions(stored([row()]), [next], NOW, { complete: true });
    assert.deepEqual(d.events.map((e) => e.type), [type]);
    const again = s.diffSessions(stored([{ ...next, last_seen_at: NOW }]), [next], NOW + 1, { complete: true });
    assert.deepEqual(again.events, []);
  }
  const failed = s.diffSessions(stored([row()]), [s.mapListRow(raw({ status: 'failed', lastRunError: 'boom' }), ctx)], NOW, {});
  assert.equal(failed.events[0].data.error, 'boom');
});

await test('token change is a change without an event; only last_seen_at moving is not a change', () => {
  const d = s.diffSessions(stored([row()]), [s.mapListRow(raw({ totalTokens: 99 }), ctx)], NOW, {});
  assert.equal(d.changed, true); assert.deepEqual(d.events, []);
});

await test('rows missing from a complete listing get gone; incomplete listing and cron runs do not', () => {
  const a = row(); const b = row({ session_key: 'agent:main:dashboard:x' }); const run = row({ session_key: 'agent:main:cron:j:run:s', kind: 'cron_run' });
  const st = stored([a, b, run]);
  const inc = [s.mapListRow(raw(), ctx)];
  assert.deepEqual(s.diffSessions(st, inc, NOW, { complete: true }).gone, ['agent:main:dashboard:x']);
  assert.deepEqual(s.diffSessions(st, inc, NOW, { complete: false }).gone, []);
});

await test('a gone row that comes back clears gone_at (a change, no event)', () => {
  const d = s.diffSessions(stored([row({ gone_at: NOW - 1000 })]), [s.mapListRow(raw(), ctx)], NOW, { complete: true });
  assert.equal(d.rows[0].row.gone_at, null); assert.equal(d.changed, true); assert.deepEqual(d.events, []);
});

await test('started_at of a stored row survives an answer without one', () => {
  const next = s.mapListRow(raw({ startedAt: undefined }), ctx);
  const d = s.diffSessions(stored([row({ started_at: 123 })]), [next], NOW, {});
  assert.equal(d.rows[0].row.started_at, 123);
});

await test('garbled answers throw before anything can be written', async () => {
  for (const bad of [null, {}, { ok: false }, { sessions: 'x' }, { sessions: [], hasMore: true }, { sessions: [] }]) {
    await assert.rejects(() => s.readAllSessions(async () => bad, ctx));
  }
  await assert.rejects(() => s.readAllSessions(async () => { throw new Error('timed out'); }, ctx));
});

await test('an empty list is only believed with totalCount 0', async () => {
  const r = await s.readAllSessions(async () => ({ sessions: [], totalCount: 0, hasMore: false }), ctx);
  assert.deepEqual(r, { rows: [], complete: true });
});

await test('a truncated listing (fewer rows than totalCount) is not complete; no totalCount is never complete', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => raw({ key: `agent:main:dashboard:${i}` }));
  const cut = await s.readAllSessions(async () => ({ sessions: rows, hasMore: false, totalCount: 150 }), ctx);
  assert.equal(cut.rows.length, 100); assert.equal(cut.complete, false);
  const noTotal = await s.readAllSessions(async () => ({ sessions: rows, hasMore: false }), ctx);
  assert.equal(noTotal.complete, false);
  // rows of another OpenClaw agent id still count towards the total
  const mixed = await s.readAllSessions(async () => ({ sessions: [raw(), raw({ key: 'agent:other:main' })], hasMore: false, totalCount: 2 }), ctx);
  assert.deepEqual([mixed.rows.length, mixed.complete], [1, true]);
  // and a truncated listing marks nothing gone
  const d = s.diffSessions(stored([row({ session_key: 'agent:main:dashboard:999' })]), cut.rows.map((r) => ({ ...r })), NOW, { complete: cut.complete });
  assert.deepEqual(d.gone, []);
});

await test('an agent whose only sessions belong to another agent id is empty, not an error', async () => {
  const r = await s.readAllSessions(async () => ({ sessions: [raw({ key: 'agent:x:main' })], hasMore: false, totalCount: 1 }), ctx);
  assert.deepEqual(r, { rows: [], complete: true });
  await assert.rejects(() => s.readAllSessions(async () => ({ sessions: [], hasMore: false }), ctx));
});

await test('one end event per cron run: the cron job row writes none', () => {
  const job = (status, extra = {}) => s.mapListRow(raw({ key: 'agent:main:cron:j1', classification: 'cron', status, ...extra }), ctx);
  const prev = { ...job('running'), last_seen_at: NOW - 1000, gone_at: null };
  assert.deepEqual(s.diffSessions(stored([prev]), [job('done', { endedAt: NOW - 5 })], NOW, {}).events, []);
  assert.deepEqual(s.diffSessions(stored([]), [job('running')], NOW, {}).events, []);
  const run = s.mapListRow(raw({ key: 'agent:main:cron:j1:run:s1', classification: 'cron_run', status: 'running' }), ctx);
  const runDone = s.mapListRow(raw({ key: 'agent:main:cron:j1:run:s1', classification: 'cron_run', status: 'done', endedAt: NOW - 5 }), ctx);
  assert.deepEqual(s.diffSessions(stored([{ ...run, last_seen_at: NOW, gone_at: null }]), [runDone], NOW, {}).events.map((e) => e.type), ['session_ended']);
});

await test('done -> running (a new turn) writes session_started once', () => {
  const done = row({ status: 'done', ended_at: NOW - 5000 });
  const next = s.mapListRow(raw({ status: 'running', updatedAt: NOW - 100 }), ctx);
  const d = s.diffSessions(stored([done]), [next], NOW, {});
  assert.deepEqual(d.events.map((e) => e.type), ['session_started']);
  const again = s.diffSessions(stored([{ ...d.rows[0].row }]), [next], NOW + 1, {});
  assert.deepEqual(again.events, []);
  // running -> running and a first-seen state change from '' write nothing
  assert.deepEqual(s.diffSessions(stored([row()]), [s.mapListRow(raw({ totalTokens: 1 }), ctx)], NOW, {}).events, []);
});

await test('retention keeps rows the listing still returns; prunes by last_seen_at, cron runs by updated_at, only new-format cron events', () => {
  const db = new Database(':memory:');
  db.exec(s.CREATE_TABLES_SQL);
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, session_id TEXT, type TEXT, data TEXT)');
  const DAY = 86_400_000;
  const ins = db.prepare(`INSERT INTO agent_sessions (container, session_key, kind, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`);
  ins.run('c1', 'agent:main:main', 'main', NOW - 31 * DAY, NOW);              // idle but still listed: stays
  ins.run('c1', 'agent:main:dashboard:old', 'dashboard', NOW - 40 * DAY, NOW - 35 * DAY); // not listed for 35 days: goes
  ins.run('c1', 'agent:main:cron:j', 'cron', NOW - 20 * DAY, NOW);            // job row still listed: stays
  ins.run('c1', 'agent:main:cron:j:run:old', 'cron_run', NOW - 8 * DAY, NOW); // old run: goes
  ins.run('c1', 'agent:main:cron:j:run:new', 'cron_run', NOW - 1 * DAY, NOW); // stays
  const ev = db.prepare('INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, ?)');
  ev.run(NOW - 8 * DAY, 'agent:main:cron:j:run:old', 'session_ended', '{}');   // new format: goes
  ev.run(NOW - 8 * DAY, 'agent:main:cron:j:run:old', 'subagent_spawned', '{}'); // goes
  ev.run(NOW - 8 * DAY, 'agent:main:cron:j', 'spawn', '{}');                    // old format: left to the 30-day rule
  ev.run(NOW - 8 * DAY, 'agent:main:cron:j', 'session_x', '{}');                // not a type this collector writes? session_ prefix: goes
  const run = (sql, cutoff) => db.prepare(sql).run(cutoff, 5000).changes;
  assert.equal(run(s.PRUNE_SQL.sessions, NOW - s.RETENTION_MS), 1);
  assert.equal(run(s.PRUNE_SQL.cronRuns, NOW - s.CRON_RETENTION_MS), 1);
  assert.equal(run(s.PRUNE_SQL.cronJobs, NOW - s.CRON_RETENTION_MS), 0);
  assert.equal(run(s.PRUNE_SQL.cronEvents, NOW - s.CRON_RETENTION_MS), 3);
  const left = db.prepare('SELECT session_key FROM agent_sessions ORDER BY session_key').all().map((r) => r.session_key);
  assert.deepEqual(left, ['agent:main:cron:j', 'agent:main:cron:j:run:new', 'agent:main:main']);
  assert.deepEqual(db.prepare('SELECT type FROM events').all().map((r) => r.type), ['spawn']);
});

await test('at start, containers with live rows that are not running now are the ones to mark gone', () => {
  assert.deepEqual(s.containersToMarkGone(['a', 'b', 'a', 'c'], ['b']), ['a', 'c']);
  assert.deepEqual(s.containersToMarkGone([], ['b']), []);
  assert.deepEqual(s.containersToMarkGone(['a'], []), ['a']);
  assert.deepEqual(s.containersToMarkGone([null, '', 'a'], ['a']), []);
});

await test('paging follows nextOffset, merges pages, fails when a page fails or does not advance', async () => {
  const calls = [];
  const pages = [
    { sessions: [raw()], hasMore: true, nextOffset: 1, totalCount: 2 },
    { sessions: [raw({ key: 'agent:main:cron:j' })], hasMore: false, totalCount: 2 },
  ];
  const r = await s.readAllSessions(async (p) => { calls.push(p); return pages[calls.length - 1]; }, ctx);
  assert.equal(r.rows.length, 2); assert.equal(r.complete, true);
  assert.deepEqual(calls.map((c) => c.offset), [undefined, 1]);
  assert.equal(calls[0].archived, 'all'); assert.equal(calls[0].limit, 200);
  await assert.rejects(() => s.readAllSessions(async () => ({ sessions: [raw()], hasMore: true, nextOffset: 0 }), ctx), /advance/);
  let n = 0;
  await assert.rejects(() => s.readAllSessions(async () => { if (n++) throw new Error('boom'); return pages[0]; }, ctx));
});

await test('cron run rows: key, parent, status, times', () => {
  const r = s.mapCronRun({ sessionId: 'S1', status: 'error', error: 'x', runAtMs: 1000, durationMs: 500, model: 'm', action: 'finished' }, 'j1', ctx);
  assert.equal(r.session_key, 'agent:main:cron:j1:run:S1'); assert.equal(r.kind, 'cron_run');
  assert.equal(r.parent_key, 'agent:main:cron:j1'); assert.equal(r.parent_kind, 'cron');
  assert.equal(r.status, 'failed'); assert.equal(r.ended_at, 1500); assert.equal(r.cost_usd, null);
  assert.equal(s.mapCronRun({ status: 'ok' }, 'j1', ctx), null);
  assert.equal(s.mapCronRun({ sessionId: 'S', action: 'started' }, 'j1', ctx), null);
  assert.equal(s.mapCronRun({ sessionId: 'S' }, 'bad id;', ctx), null);
  assert.throws(() => s.parseCronRuns({ ok: true }));
});

await test('cron runs to read: only moved job rows, bounded, never a bad id', () => {
  const j = (id, upd, over = {}) => row({ session_key: `agent:main:cron:${id}`, kind: 'cron', updated_at: upd, ...over });
  const rows = [j('a', NOW - 1000), j('b', NOW - 2000), j('old', NOW - 9 * 86_400_000), j('gone', NOW, { gone_at: NOW }), row()];
  const read = new Map([['b', NOW - 2000]]);
  assert.deepEqual(s.cronJobsToRead(rows, read, NOW, 5).map((x) => x.jobId), ['a']);
  assert.equal(s.cronJobsToRead(rows, new Map(), NOW, 1).length, 1);
});

await test('adaptive interval: 30 s running, 60 s idle, doubling to 10 min on failures', () => {
  assert.equal(s.nextDelayMs(true), 30_000); assert.equal(s.nextDelayMs(false), 60_000);
  assert.equal(s.nextDelayMs(true, 1), 60_000); assert.equal(s.nextDelayMs(false, 3), 240_000);
  assert.equal(s.nextDelayMs(false, 30), 600_000);
});

await test('cron ids: no leading dash, 128 chars at most', () => {
  assert.equal(s.validJobId('-rf'), false); assert.equal(s.validJobId('--help'), false);
  assert.equal(s.validJobId('a-b_c1'), true); assert.equal(s.validJobId('_x'), true);
  assert.equal(s.validJobId('a'.repeat(128)), true); assert.equal(s.validJobId('a'.repeat(129)), false);
  assert.equal(s.validJobId(''), false); assert.equal(s.validJobId('a b'), false);
});

await test('failing cron jobs back off (5 min doubling to 6 h) and never starve the others', () => {
  assert.equal(s.cronBackoffMs(1), 300_000); assert.equal(s.cronBackoffMs(2), 600_000);
  assert.equal(s.cronBackoffMs(3), 1_200_000); assert.equal(s.cronBackoffMs(50), 6 * 3600_000);
  const j = (id, upd) => row({ session_key: `agent:main:cron:${id}`, kind: 'cron', updated_at: upd });
  const rows = ['f1', 'f2', 'f3', 'f4', 'f5', 'ok1', 'ok2'].map((id, i) => j(id, NOW - 1000 - i));
  const failed = new Map(['f1', 'f2', 'f3', 'f4', 'f5'].map((id) => [id, { at: NOW - 60_000, failures: 1 }]));
  assert.deepEqual(s.cronJobsToRead(rows, new Map(), NOW, 5, failed).map((x) => x.jobId), ['ok1', 'ok2'], 'five failing jobs are skipped');
  assert.equal(s.cronJobsToRead(rows, new Map(), NOW + 300_001, 7, failed).length, 7, 'retried after the backoff');
  const failed2 = new Map([['f1', { at: NOW, failures: 2 }]]);
  assert.ok(!s.cronJobsToRead(rows, new Map(), NOW + 400_000, 7, failed2).some((x) => x.jobId === 'f1'), 'second failure waits 10 min');
  // never read first, then the oldest read
  const read = new Map([['ok1', NOW - 5000], ['f1', NOW - 9000]]);
  const order = s.cronJobsToRead(rows, read, NOW, 7).map((x) => x.jobId);
  assert.deepEqual(order.slice(0, 5).sort(), ['f2', 'f3', 'f4', 'f5', 'ok2'], 'never-read jobs come first');
  assert.deepEqual(order.slice(5), ['f1', 'ok1'], 'then the oldest read first');
});

console.log(`\n${passed} passed`);
