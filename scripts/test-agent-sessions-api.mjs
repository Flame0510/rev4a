#!/usr/bin/env node
/**
 * Tests for lib/agent-sessions-db.ts (read helpers on the agent_sessions table).
 *
 *   node scripts/test-agent-sessions-api.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const Database = createRequire(import.meta.url)('better-sqlite3');
const m = await import('../lib/agent-sessions-db.ts');

const DDL = `
CREATE TABLE agent_sessions (container TEXT NOT NULL, session_key TEXT NOT NULL, agent_name TEXT, session_id TEXT, kind TEXT,
  parent_key TEXT, parent_kind TEXT, spawn_depth INTEGER, label TEXT, status TEXT, last_error TEXT, model TEXT, provider TEXT,
  input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cost_usd REAL, cron_job_id TEXT, started_at INTEGER,
  updated_at INTEGER, ended_at INTEGER, archived_at INTEGER, last_seen_at INTEGER, gone_at INTEGER, PRIMARY KEY (container, session_key));
CREATE TABLE agent_sessions_meta (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT);
`;
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
function seed(db) {
  db.exec(DDL);
  db.prepare('INSERT INTO agent_sessions_meta VALUES (1, 7)').run();
  const ins = db.prepare(`INSERT INTO agent_sessions (container, session_key, agent_name, kind, parent_key, parent_kind, status, cost_usd, updated_at)
    VALUES (@container, @session_key, @agent_name, @kind, @parent_key, @parent_kind, @status, @cost_usd, @updated_at)`);
  const row = (o) => ins.run({ agent_name: null, kind: 'main', parent_key: null, parent_kind: null, status: 'done', cost_usd: null, updated_at: NOW - 1000, ...o });
  row({ container: 'a1', session_key: 'agent:main:main', agent_name: 'Atlas' });
  row({ container: 'a2', session_key: 'agent:main:main', agent_name: 'Argus', cost_usd: 0.25 });
  row({ container: 'a1', session_key: 'agent:main:subagent:x', kind: 'subagent', parent_key: 'agent:main:main', parent_kind: 'spawn', updated_at: NOW - 500 });
  row({ container: 'a1', session_key: 'agent:main:dashboard:d', kind: 'dashboard', parent_key: 'agent:main:missing', parent_kind: 'nav' });
  row({ container: 'a1', session_key: 'agent:main:old', updated_at: NOW - 30 * DAY });
  row({ container: 'a1', session_key: 'agent:main:oldrun', status: 'running', updated_at: NOW - 30 * DAY });
  row({ container: 'a1', session_key: 'agent:main:ghost', status: 'running', updated_at: NOW - 30 * DAY });
  db.prepare("UPDATE agent_sessions SET gone_at = ? WHERE session_key = 'agent:main:ghost'").run(NOW);
  db.prepare('INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, ?)').run(1, 'agent:main:main', 'session_started', JSON.stringify({ container: 'a1' }));
  db.prepare('INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, ?)').run(2, 'agent:main:main', 'session_started', JSON.stringify({ container: 'a2' }));
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

test('missing table answers empty, never throws', () => {
  const db = new Database(':memory:');
  assert.deepEqual(m.listSessions(db), { sessions: [], total: 0, version: 0 });
  assert.equal(m.getSession(db, { key: 'k' }).status, 404);
});

const db = new Database(':memory:');
seed(db);

test('default list: active or last 7 days, newest first, version from meta', () => {
  const r = m.listSessions(db, { now: NOW });
  const keys = r.sessions.map((s) => s.uid);
  assert.ok(!keys.includes('a1|agent:main:old'));
  assert.ok(keys.includes('a1|agent:main:oldrun'), 'running row stays');
  assert.ok(!keys.includes('a1|agent:main:ghost'), 'gone running row is not active');
  assert.equal(r.version, 7);
  assert.equal(r.total, r.sessions.length);
  assert.equal(r.sessions[0].session_key, 'agent:main:subagent:x');
});

test('two containers with the same key stay apart; cost null is not 0', () => {
  const r = m.listSessions(db, { now: NOW });
  const mains = r.sessions.filter((s) => s.session_key === 'agent:main:main');
  assert.equal(mains.length, 2);
  assert.equal(mains.find((s) => s.container === 'a1').cost_usd, null);
  assert.equal(mains.find((s) => s.container === 'a2').cost_usd, 0.25);
});

test('parent_uid only when the parent row exists in the same container; legacy fields', () => {
  const r = m.listSessions(db, { now: NOW });
  const sub = r.sessions.find((s) => s.session_key === 'agent:main:subagent:x');
  assert.equal(sub.parent_uid, 'a1|agent:main:main');
  assert.equal(sub.parent_id, 'agent:main:main');
  assert.equal(sub.id, sub.session_key);
  const dash = r.sessions.find((s) => s.kind === 'dashboard');
  assert.equal(dash.parent_uid, null);
  assert.equal(dash.parent_id, 'agent:main:missing');
});

test('filters: container, kind, active, since, limit', () => {
  assert.ok(m.listSessions(db, { container: 'a2', now: NOW }).sessions.every((s) => s.container === 'a2'));
  assert.equal(m.listSessions(db, { kind: 'subagent', now: NOW }).total, 1);
  assert.deepEqual(m.listSessions(db, { active: true, now: NOW }).sessions.map((s) => s.session_key), ['agent:main:oldrun']);
  assert.ok(m.listSessions(db, { since: NOW - 40 * DAY, now: NOW }).sessions.some((s) => s.session_key === 'agent:main:old'));
  const l = m.listSessions(db, { limit: 2, now: NOW });
  assert.equal(l.sessions.length, 2);
  assert.ok(l.total > 2);
});

test('detail: key alone ambiguous across containers is 400, with container it works', () => {
  const amb = m.getSession(db, { key: 'agent:main:main' });
  assert.equal(amb.ok, false);
  assert.equal(amb.status, 400);
  const r = m.getSession(db, { container: 'a1', key: 'agent:main:main' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.children.map((c) => c.session_key), ['agent:main:subagent:x']);
  assert.equal(r.events.length, 1, 'events of the other container are not mixed in');
  assert.equal(m.getSession(db, { container: 'a1', key: 'nope' }).status, 404);
  assert.equal(m.getSession(db, { key: 'agent:main:old' }).ok, true, 'unique key works without container');
});

test('one events row with non-JSON data does not empty the feed; the other rows keep their container', () => {
  const d = new Database(':memory:');
  seed(d);
  d.prepare('INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, ?)').run(3, 'agent:main:main', 'session_ended', 'not json');
  d.prepare('INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, NULL)').run(4, 'agent:main:main', 'session_ended');
  const asc = m.recentEvents(d, { limit: 20, afterId: 0, ascending: true });
  assert.equal(asc.length, 4);
  assert.deepEqual(asc.map((e) => e.id), [1, 2, 3, 4], 'afterId can keep advancing past the bad row');
  assert.equal(asc[0].container, 'a1');
  assert.equal(asc[2].container, null);
  assert.equal(m.recentEvents(d, { limit: 20, afterId: 3 }).length, 1);
  const detail = m.getSession(d, { container: 'a1', key: 'agent:main:main' });
  assert.equal(detail.ok, true);
  assert.equal(detail.events.length, 1, 'detail events survive a bad row too');
});

test('a failed read says so (the stream keeps its last frame); a read error in events is not an empty feed', () => {
  const d = new Database(':memory:');
  seed(d);
  d.exec('DROP TABLE agent_sessions_meta');
  const r = m.listSessions(d, { now: NOW });
  assert.equal(r.sessions.length > 0, true, 'a missing meta table only means version 0');
  d.exec('ALTER TABLE agent_sessions RENAME COLUMN status TO state');
  const bad = m.listSessions(d, { now: NOW });
  assert.equal(bad.error, true);
  assert.equal(bad.sessions.length, 0);
  assert.equal(m.listSessions(new Database(':memory:')).error, undefined, 'no table is empty, not an error');
  const e = new Database(':memory:');
  assert.throws(() => m.recentEvents(e, { limit: 5 }));
});

test('the stream list and /api/sessions use the same cap: 2,000 rows are all returned', () => {
  const d = new Database(':memory:');
  d.exec(DDL);
  d.prepare('INSERT INTO agent_sessions_meta VALUES (1, 1)').run();
  const ins = d.prepare("INSERT INTO agent_sessions (container, session_key, kind, status, updated_at) VALUES ('c', ?, 'direct', 'done', ?)");
  d.transaction(() => { for (let i = 0; i < 2500; i++) ins.run(`agent:main:dashboard:${i}`, NOW - i); })();
  const r = m.listSessions(d, { now: NOW });
  assert.equal(r.sessions.length, 2000);
  assert.equal(r.total, 2500);
  assert.equal(m.SESSIONS_CAP, 2000);
});

test('cost: a NULL cost is filled from costs.db by (container, session_id); 0 or missing stays null; no table is fine', () => {
  const d = new Database(':memory:');
  seed(d);
  d.prepare("UPDATE agent_sessions SET session_id = 'S-main', kind = 'cron_run' WHERE container = 'a1' AND session_key = 'agent:main:main'").run();
  d.prepare("UPDATE agent_sessions SET session_id = 'S-sub' WHERE container = 'a1' AND session_key = 'agent:main:subagent:x'").run();
  d.prepare("UPDATE agent_sessions SET session_id = 'S-main' WHERE container = 'a2'").run();
  const c = new Database(':memory:');
  c.exec('CREATE TABLE agent_cost_sessions (container TEXT NOT NULL, session_id TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (container, session_id))');
  c.prepare("INSERT INTO agent_cost_sessions VALUES ('a1', 'S-main', 0.4), ('a1', 'S-sub', 0), ('a2', 'S-main', 9)").run();
  const r = m.listSessions(d, { now: NOW, costsDb: c });
  const by = (container, key) => r.sessions.find((s) => s.container === container && s.session_key === key);
  assert.equal(by('a1', 'agent:main:main').cost_usd, 0.4);
  assert.equal(by('a1', 'agent:main:subagent:x').cost_usd, null, 'cost 0 is not priced');
  assert.equal(by('a2', 'agent:main:main').cost_usd, 0.25, 'a cost the listing carried is never overwritten');
  const det = m.getSession(d, { container: 'a1', key: 'agent:main:main', costsDb: c });
  assert.equal(det.session.cost_usd, 0.4);
  const noTable = new Database(':memory:');
  assert.equal(m.listSessions(d, { now: NOW, costsDb: noTable }).sessions.length, r.sessions.length);
  assert.equal(by('a1', 'agent:main:dashboard:d').cost_usd, null);
  assert.equal(m.listSessions(d, { now: NOW }).sessions.find((s) => s.session_key === 'agent:main:subagent:x').cost_usd, null);
});

console.log(`\n${passed} passed`);
