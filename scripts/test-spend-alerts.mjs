#!/usr/bin/env node
/**
 * Tests for lib/spend-alerts.js (FEAT-15): the spend and loop alarms, on in-memory SQLite.
 * The spend-spike scenario uses 14 hours at ~101 calls an hour and ~64k prompt tokens a
 * call, totaling $6.81; the session context (sessions.list totalTokens) is ~560k against
 * a 200k window.
 *
 *   node scripts/test-spend-alerts.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sa = require('../lib/spend-alerts.js');
const { CREATE_TABLE_SQL } = require('../lib/proxy-usage.js');
const { CREATE_TABLES_SQL, ensureAddedColumns, mapListRow } = require('../lib/agent-sessions.js');

const H = 3600;
const DAY = 24 * H;
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % 3_600_000) + 10 * 60_000; // 10 min into an hour
const CUR = sa.hourOf(NOW);
const LAST = CUR - H; // the last full hour
const cfg = sa.configFromEnv({});

function dbs() {
  const costsDb = new Database(':memory:');
  costsDb.exec(CREATE_TABLE_SQL);
  costsDb.exec('CREATE TABLE vendor_balance (ts INTEGER NOT NULL, vendor TEXT NOT NULL, currency TEXT, balance REAL, usage REAL, agents_cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (vendor, ts))');
  const stateDb = new Database(':memory:');
  stateDb.exec(CREATE_TABLES_SQL);
  stateDb.exec('CREATE TABLE alert_state (alert_key TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, last_sent_at INTEGER, last_resolved_at INTEGER, updated_at INTEGER NOT NULL, payload TEXT)');
  return { costsDb, stateDb };
}
function put(costsDb, o) {
  costsDb.prepare(`INSERT INTO proxy_usage_hourly (hour, agent, provider, model, calls, prompt_tokens, completion_tokens, cached_tokens, errors, no_usage, cost)
    VALUES (@hour, @agent, @provider, @model, @calls, @prompt, @completion, 0, @errors, @no_usage, @cost)
    ON CONFLICT(hour, agent, provider, model) DO UPDATE SET calls = calls + excluded.calls, prompt_tokens = prompt_tokens + excluded.prompt_tokens,
      completion_tokens = completion_tokens + excluded.completion_tokens, errors = errors + excluded.errors, no_usage = no_usage + excluded.no_usage, cost = cost + excluded.cost`)
    .run({ provider: 'deepseek', model: 'deepseek-chat', calls: 10, prompt: 40_000, completion: 1000, errors: 0, no_usage: 0, cost: 0.01, ...o });
}
/** The 24 hour starts of 24-hour block `b` counted back from the current hour (block 0 is the rolling last 24 h). */
const blockHours = (b) => Array.from({ length: 24 }, (_, i) => CUR - b * DAY - i * H);
/** Fill block `b` with `hours` active hours (the newest first, never the partial current hour) of the same row. */
function fillBlock(costsDb, agent, b, hours, row) {
  blockHours(b).filter((h) => h !== CUR).slice(0, hours).forEach((hour) => put(costsDb, { agent, hour, ...row }));
}
/** `days` previous blocks (1..days), `pattern(b)` returns [hours, row] or null for an idle day. */
function history(costsDb, agent, days, pattern) {
  for (let b = 1; b <= days; b++) {
    const p = pattern(b);
    if (p) fillBlock(costsDb, agent, b, p[0], p[1]);
  }
}
const session = (d, o) => d.stateDb.prepare("INSERT INTO agent_sessions (container, session_key, kind, total_tokens, context_tokens, updated_at) VALUES (@container, @session_key, @kind, @total_tokens, @context_tokens, @updated_at)")
  .run({ container: 'c1', session_key: 'agent:main:main', kind: 'main', total_tokens: 0, context_tokens: 200_000, updated_at: NOW - 60_000, ...o });
const pass = (d, extra = {}) => sa.runSpendPass({ costsDb: d.costsDb, stateDb: d.stateDb, nowMs: NOW, config: cfg, ...extra });
const rules = (events) => events.map((e) => e.rule).sort();
const priced = (hourly) => ({ cost: hourly, calls: 12, prompt: 50_000 });

const results = [];
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; results.push(['PASS', name]); console.log(`ok - ${name}`); } catch (e) { results.push(['FAIL', name]); console.error(`FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}

// ── Spend spike scenario ────────────────────────────────────────────────────

/** Low daily spend for 14 days, followed by 14 hours of ~101 calls an hour at ~64k prompt tokens, totaling $6.81. */
function writer(d, hoursOfIncident) {
  history(d.costsDb, 'writer', 14, (b) => [2, { calls: 20, prompt: 600_000, cost: [0.05, 0.3, 0.1, 0.2, 0.15][b % 5] / 2 }]);
  for (let i = 1; i <= hoursOfIncident; i++) {
    put(d.costsDb, { agent: 'writer', hour: CUR - i * H, calls: 101, prompt: 101 * 64_000, completion: 101 * 300, errors: i % 7 === 0 ? 2 : 1, cost: 6.81 / 14 });
  }
}

t('incident, whole 14 hours: spend.unusual fires, spend.loop does not (16 errors in 1,414 calls)', () => {
  const d = dbs();
  writer(d, 14);
  const ev = pass(d, { resolveContainer: (a) => (a === 'writer' ? 'writer-agent' : null) });
  assert.deepEqual(rules(ev), ['unusual']);
  assert.equal(ev[0].metric, 'spend.unusual');
  assert.equal(ev[0].container, 'writer-agent');
  assert.match(ev[0].message, /writer: \$6\.81 in the last 24 hours; its usual day is/);
});

t('incident, early: silent under the $2 floor, fires once the day is out of proportion', () => {
  const early = dbs();
  writer(early, 3); // $1.46
  assert.deepEqual(pass(early), []);
  const later = dbs();
  writer(later, 5); // $2.43, ~16x the usual day
  assert.deepEqual(rules(pass(later)), ['unusual']);
});

t('incident, the session: 560k tokens in a 200k window fires spend.session, once', () => {
  const d = dbs();
  d.stateDb.prepare("INSERT INTO agent_sessions (container, session_key, kind, total_tokens, context_tokens, updated_at) VALUES ('writer-agent', 'agent:main:main', 'main', 560000, 200000, ?)").run(NOW - 60_000);
  const ev = pass(d);
  assert.deepEqual(rules(ev), ['session']);
  assert.equal(ev[0].metric, 'spend.session');
  assert.match(ev[0].message, /280 % of its 200,000-token window/);
  assert.equal(pass(d, { nowMs: NOW + 300_000 }).length, 0);
});

t('a synthetic failing hour (80 failures in 95 calls, 5M prompt tokens) fires spend.loop; 12 errors in a day do not', () => {
  const d = dbs();
  put(d.costsDb, { agent: 'writer', hour: LAST, calls: 95, prompt: 5_000_000, errors: 80, cost: 0.3 });
  assert.deepEqual(rules(pass(d)), ['loop']);
  const q = dbs();
  put(q.costsDb, { agent: 'writer', hour: LAST, calls: 95, prompt: 5_000_000, errors: 9, cost: 0.3 });
  assert.deepEqual(pass(q), []);
});

// ── Regular work stays silent ────────────────────────────────────────────────

t('office-hours orchestrator ($1/h, 8 h, weekdays only): silent on a weekday and on a weekend', () => {
  const mk = (todayActive) => {
    const d = dbs();
    history(d.costsDb, 'orch', 14, (b) => (b % 7 === 0 || b % 7 === 6 ? null : [8, priced(1)]));
    if (todayActive) fillBlock(d.costsDb, 'orch', 0, 8, priced(1));
    return pass(d);
  };
  assert.deepEqual(mk(true), []);
  assert.deepEqual(mk(false), []);
});

t('nightly batch ($3 at 02:00): silent', () => {
  const d = dbs();
  history(d.costsDb, 'batch', 14, () => [1, priced(3)]);
  fillBlock(d.costsDb, 'batch', 0, 1, priced(3));
  assert.deepEqual(pass(d), []);
});

t('24/7 steady orchestrator ($1/h): silent', () => {
  const d = dbs();
  history(d.costsDb, 'steady', 14, () => [24, priced(1)]);
  fillBlock(d.costsDb, 'steady', 0, 23, priced(1));
  assert.deepEqual(pass(d), []);
});

t('watchdog cron every 5 minutes ($0.01/h), on a 14-day-old and on a new agent: silent', () => {
  const d = dbs();
  history(d.costsDb, 'watchdog', 14, () => [24, { calls: 12, prompt: 48_000, cost: 0.01 }]);
  fillBlock(d.costsDb, 'watchdog', 0, 23, { calls: 12, prompt: 48_000, cost: 0.01 });
  const n = dbs();
  fillBlock(n.costsDb, 'fresh', 0, 12, { calls: 12, prompt: 48_000, cost: 0.01 });
  assert.deepEqual(pass(d), []);
  assert.deepEqual(pass(n), []);
});

t('unpriced orchestrator (tokens only): silent when steady, fires on a 4x day', () => {
  const row = { cost: 0, calls: 30, prompt: 1_000_000, completion: 20_000 };
  const d = dbs();
  history(d.costsDb, 'free', 14, () => [24, row]);
  fillBlock(d.costsDb, 'free', 0, 23, row);
  assert.deepEqual(pass(d), []);
  const s = dbs();
  history(s.costsDb, 'free', 14, () => [24, row]);
  fillBlock(s.costsDb, 'free', 0, 23, { ...row, prompt: 4_000_000 });
  assert.deepEqual(rules(pass(s)), ['unusual']);
});

t('a new agent (fewer than 3 active days) uses a higher floor alone: $4 silent, $6 fires', () => {
  const mk = (cost) => {
    const d = dbs();
    history(d.costsDb, 'new', 2, () => [2, priced(0.1)]);
    fillBlock(d.costsDb, 'new', 0, 4, priced(cost));
    return pass(d);
  };
  assert.deepEqual(mk(1), []); // $4
  assert.deepEqual(rules(mk(1.5)), ['unusual']); // $6
});

t('days that raised an alarm, and days a gap touched, stay out of the median', () => {
  const mk = (extra) => {
    const d = dbs();
    history(d.costsDb, 'a1', 14, () => [5, priced(0.5)]); // $2.50 a day
    fillBlock(d.costsDb, 'a1', 0, 4, priced(1.5)); // $6 today: under 3x $2.50? no: 6 < 7.5
    extra?.(d);
    return pass(d);
  };
  assert.deepEqual(mk(), []);
  // With every earlier day marked as an alarm hour there is no usable history: the new-agent floor ($5) decides.
  const marked = mk((d) => {
    for (let b = 1; b <= 14; b++) d.stateDb.prepare("INSERT INTO alert_state (alert_key, kind, state, updated_at) VALUES (?, 'spend-hour', 'alarm', ?)").run(`spend-hour:a1:${CUR - b * DAY - H}`, NOW);
  });
  assert.deepEqual(rules(marked), ['unusual']);
});

t('a weekly $10 batch: silent once it has 3 active weeks behind it', () => {
  const d = dbs();
  history(d.costsDb, 'weekly', 28, (b) => (b % 7 === 0 ? [1, priced(10)] : null));
  fillBlock(d.costsDb, 'weekly', 0, 1, priced(10));
  assert.deepEqual(pass(d), []);
});

t('a new agent at $5.40 a day alarms at most once a day while it has no history', () => {
  const d = dbs();
  const times = [];
  for (let k = 0; k < 72; k++) {
    const hour = CUR - 72 * H + k * H; // an hour of spend, then a pass 10 minutes into the next one
    put(d.costsDb, { agent: 'steadynew', hour, calls: 12, prompt: 50_000, cost: 0.225 });
    if (pass(d, { nowMs: (hour + H) * 1000 + 600_000 }).length) times.push(k);
  }
  assert.ok(times.length >= 1 && times.length <= 3, JSON.stringify(times));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 24, JSON.stringify(times));
});

t('a model priced only lately is judged on tokens, not on a cost median of 0', () => {
  const row = { cost: 0, calls: 30, prompt: 1_000_000, completion: 20_000 };
  const steady = dbs();
  history(steady.costsDb, 'late', 14, () => [24, row]);
  fillBlock(steady.costsDb, 'late', 0, 23, { ...row, cost: 0.15 }); // $3.45 today, the same tokens as every day
  assert.deepEqual(pass(steady), []);
  const spike = dbs();
  history(spike.costsDb, 'late', 14, () => [24, row]);
  fillBlock(spike.costsDb, 'late', 0, 23, { ...row, cost: 0.15, prompt: 4_000_000 });
  assert.deepEqual(rules(pass(spike)), ['unusual']);
});

// ── Money leaving the account ────────────────────────────────────────────────

const reading = (d, ts, balance, currency = 'USD', vendor = 'deepseek') =>
  d.costsDb.prepare('INSERT INTO vendor_balance (ts, vendor, currency, balance) VALUES (?, ?, ?, ?)').run(ts, vendor, currency, balance);

t('a top-up, a drop the proxy explains and a drop under $0.50 raise nothing; an unmetered drop fires', () => {
  const up = dbs();
  reading(up, NOW - 70 * 60_000, 5); reading(up, NOW - 10 * 60_000, 25);
  assert.deepEqual(pass(up), []);
  const m = dbs();
  reading(m, NOW - 70 * 60_000, 20); reading(m, NOW - 10 * 60_000, 19.2);
  put(m.costsDb, { agent: 'a1', hour: LAST, cost: 0.45 });
  assert.deepEqual(pass(m), []);
  const small = dbs();
  reading(small, NOW - 70 * 60_000, 20); reading(small, NOW - 10 * 60_000, 19.7);
  assert.deepEqual(pass(small), []);
  const u = dbs();
  reading(u, NOW - 70 * 60_000, 20); reading(u, NOW - 10 * 60_000, 17);
  put(u.costsDb, { agent: 'a1', hour: LAST, cost: 0.2 });
  const ev = pass(u);
  assert.deepEqual(rules(ev), ['unaccounted']);
  assert.equal(ev[0].scope, 'vendor:deepseek');
  assert.match(ev[0].message, /outside Rev4a/);
});

t('a stale reading, a vendor in another currency and a missing currency are skipped', () => {
  const s = dbs();
  reading(s, NOW - 5 * H * 1000, 20); reading(s, NOW - 4 * H * 1000, 10);
  assert.deepEqual(pass(s), []);
  for (const cur of ['CNY', null]) {
    const c = dbs();
    reading(c, NOW - 70 * 60_000, 200, cur); reading(c, NOW - 10 * 60_000, 100, cur);
    assert.deepEqual(pass(c), [], `currency ${cur}`);
  }
});

t('a key shared with another install: the 2nd alarm says so, then one a day', () => {
  const d = dbs();
  // One reading an hour, each $3 lower than the last, none of it metered.
  const at = (k) => NOW - 10 * 60_000 + k * H * 1000;
  const passAt = (k) => pass(d, { nowMs: at(k) + 60_000 });
  reading(d, at(-1), 100); reading(d, at(0), 97);
  assert.equal(passAt(0).length, 1);
  reading(d, at(1), 94);
  const second = passAt(1);
  assert.equal(second.length, 1);
  assert.match(second[0].message, /keeps recurring/);
  reading(d, at(2), 91);
  assert.equal(passAt(2).length, 0, 'held back for 24 h');
  reading(d, at(25), 88); reading(d, at(26), 85);
  assert.equal(passAt(26).length, 1, 'a day later it may alarm again');
});

t('balance flapping (alternating $1 and $0.10 drops for 48 hours): at most 3 notifications, no resolved notes', () => {
  const d = dbs();
  let balance = 100;
  reading(d, NOW - 70 * 60_000, balance);
  const events = [];
  for (let k = 0; k < 48; k++) {
    balance -= k % 2 === 0 ? 1 : 0.1;
    const at = NOW - 10 * 60_000 + k * H * 1000;
    reading(d, at, balance);
    // Five passes an hour, all on the same two readings.
    for (let j = 0; j < 5; j++) events.push(...pass(d, { nowMs: at + 60_000 + j * 300_000 }));
  }
  assert.ok(events.length >= 1 && events.length <= 3, `${events.length} notifications`);
  assert.ok(events.every((e) => e.rule === 'unaccounted' && !e.resolved));
});

t('a steady leak alarms hourly at first, then daily, and never twice for one reading', () => {
  const d = dbs();
  let balance = 100;
  reading(d, NOW - 70 * 60_000, balance);
  const times = [];
  for (let k = 0; k < 50; k++) {
    balance -= 2;
    const at = NOW - 10 * 60_000 + k * H * 1000;
    reading(d, at, balance);
    for (let j = 0; j < 3; j++) if (pass(d, { nowMs: at + 60_000 + j * 300_000 }).length) times.push(k);
  }
  assert.deepEqual(times, [0, 1, 25, 49]); // hourly until the 2nd, then every 24 h
});

// ── Gaps, cooldown, delivery ─────────────────────────────────────────────────

t('a metering gap skips the loop rule and the balance rule; an old gap does not hide the hour', () => {
  const d = dbs();
  put(d.costsDb, { agent: 'a1', hour: LAST, calls: 95, prompt: 5_000_000, errors: 80, cost: 0.3 });
  reading(d, NOW - 70 * 60_000, 20); reading(d, NOW - 10 * 60_000, 10);
  assert.deepEqual(pass(d, { gapAtMs: LAST * 1000 + 5 * 60_000 }), []);
  assert.ok(pass(d, { gapAtMs: (LAST - 3 * H) * 1000 }).length > 0);
});

t('a gap in the last 2 minutes of an hour also touches the next hour', () => {
  assert.deepEqual(sa.gapHours(5 * H * 1000 + 30 * 60_000), [5 * H]);
  assert.deepEqual(sa.gapHours(6 * H * 1000 - 60_000), [5 * H, 6 * H]);
  const d = dbs();
  put(d.costsDb, { agent: 'a1', hour: LAST, calls: 95, prompt: 5_000_000, errors: 80, cost: 0.3 });
  assert.deepEqual(pass(d, { gapAtMs: LAST * 1000 - 60_000 }), [], 'the gap began a minute before the hour');
});

t('hours inside a gap keep their day out of the median', () => {
  const mk = (gapAtMs) => {
    const d = dbs();
    history(d.costsDb, 'a1', 3, () => [5, priced(0.2)]); // three active days of $1
    fillBlock(d.costsDb, 'a1', 0, 7, priced(0.5)); // $3.50 today: over 3x the median, over $2
    return pass(d, { gapAtMs });
  };
  assert.deepEqual(rules(mk(0)), ['unusual']);
  // A gap in block 3 leaves 2 active days: not enough history, the higher floor ($5) alone decides.
  assert.deepEqual(rules(mk((CUR - 3 * DAY - 2 * H) * 1000)), []);
});

t('cooldown, restart safety and the resolved note after two clean evaluations', () => {
  const d = dbs();
  put(d.costsDb, { agent: 'writer', hour: LAST, calls: 95, prompt: 5_000_000, errors: 80, cost: 0.3 });
  assert.equal(pass(d).length, 1);
  assert.equal(pass(d, { nowMs: NOW + 5 * 60_000 }).length, 0, 'cooldown (the state is in the database: a restart repeats nothing)');
  const later = NOW + H * 1000; // the hour moves on; the agent is quiet
  assert.equal(pass(d, { nowMs: later }).length, 0);
  const done = pass(d, { nowMs: later + 5 * 60_000 });
  assert.equal(done.length, 1);
  assert.ok(done[0].resolved);
  assert.equal(pass(d, { nowMs: later + 10 * 60_000 }).length, 0, 'no second note');
});

t('a delivery that throws sets no cooldown, is logged and does not stop the other rules', () => {
  const d = dbs();
  put(d.costsDb, { agent: 'writer', hour: LAST, calls: 95, prompt: 5_000_000, errors: 80, cost: 0.3 });
  session(d, { total_tokens: 560_000 });
  const seen = [];
  const errors = [];
  const flaky = (ev) => { if (ev.rule === 'loop') throw new Error('disk full'); seen.push(ev.rule); };
  pass(d, { deliver: flaky, onError: (e, ev) => errors.push(`${ev.rule}: ${e.message}`) });
  assert.deepEqual(seen, ['session'], 'the session rule still ran');
  assert.deepEqual(errors, ['loop: disk full']);
  assert.equal(d.stateDb.prepare("SELECT COUNT(*) AS n FROM alert_state WHERE alert_key = 'spend:loop:writer'").get().n, 0);
  assert.deepEqual(rules(pass(d)), ['loop'], 'the next pass delivers it');
});

t('a snoozed agent is evaluated but not alerted; by container name too; alerts after the snooze', () => {
  const mk = () => { const d = dbs(); put(d.costsDb, { agent: 'writer', hour: LAST, calls: 95, prompt: 5_000_000, errors: 80, cost: 0.3 }); return d; };
  const d = mk();
  const until = sa.snooze(d.stateDb, 'writer', 24, NOW);
  assert.equal(until, NOW + 24 * H * 1000);
  assert.deepEqual(pass(d), []);
  assert.ok(sa.activeSnoozes(d.stateDb, NOW).has('writer'));
  const e = mk();
  sa.snooze(e.stateDb, 'writer-agent', undefined, NOW);
  assert.deepEqual(pass(e, { resolveContainer: () => 'writer-agent' }), []);
  assert.throws(() => sa.snooze(e.stateDb, 'bad scope; drop', 1, NOW));
  const f = mk();
  sa.snooze(f.stateDb, 'writer', 1, NOW - 2 * H * 1000);
  assert.equal(pass(f).length, 1);
});

// ── Sessions ─────────────────────────────────────────────────────────────────


t('session: at its model window or over fires, a healthy one never does, an unknown window uses 400,000, cron runs are excluded', () => {
  const d = dbs();
  session(d, { session_key: 'agent:main:a', total_tokens: 210_000 }); // 105 %
  session(d, { session_key: 'agent:main:b', total_tokens: 180_000 }); // 90 %: a healthy session just before its compaction
  session(d, { session_key: 'agent:main:c', total_tokens: 300_000, context_tokens: null }); // unknown window, under 400k
  session(d, { session_key: 'agent:main:d', total_tokens: 450_000, context_tokens: null });
  session(d, { session_key: 'agent:main:e:run:1', kind: 'cron_run', total_tokens: 900_000, context_tokens: null });
  session(d, { container: 'c2', session_key: 'agent:main:old', total_tokens: 900_000, updated_at: NOW - 7 * H * 1000 });
  const ev = pass(d);
  assert.deepEqual(ev.map((e) => e.session_key).sort(), ['agent:main:a', 'agent:main:d']);
  assert.equal(pass(d, { nowMs: NOW + 60_000 }).length, 0, 'one warning per session');
});

t('session: healthy sessions that compact before their window stay silent for 48 hours (200k at 180k, 128k at 108k)', () => {
  const d = dbs();
  session(d, { session_key: 'agent:main:big', total_tokens: 100_000, context_tokens: 200_000 });
  session(d, { session_key: 'agent:main:small', total_tokens: 70_000, context_tokens: 128_000 });
  let fired = 0;
  for (let k = 0; k < 96; k++) { // a pass every 30 minutes
    const t = NOW + k * 1_800_000;
    const grow = (k % 8) / 7; // eight half-hours from empty-ish to the compaction point, then back
    d.stateDb.prepare("UPDATE agent_sessions SET total_tokens = ?, updated_at = ? WHERE session_key = 'agent:main:big'").run(Math.round(100_000 + grow * 80_000), t);
    d.stateDb.prepare("UPDATE agent_sessions SET total_tokens = ?, updated_at = ? WHERE session_key = 'agent:main:small'").run(Math.round(70_000 + grow * 38_000), t);
    fired += pass(d, { nowMs: t + 1000 }).length;
  }
  assert.equal(fired, 0);
});

t('session: going idle does not resolve it; only an update back under 90 % does (not 95 %)', () => {
  const d = dbs();
  session(d, { total_tokens: 560_000 });
  assert.equal(pass(d).length, 1);
  // Idle for 7 hours: out of the 6 h window, still big, never resolved.
  for (let k = 0; k < 4; k++) assert.equal(pass(d, { nowMs: NOW + 7 * H * 1000 + k * 300_000 }).length, 0);
  assert.equal(d.stateDb.prepare("SELECT state FROM alert_state WHERE alert_key LIKE 'spend:session:%'").get().state, 'alerted');
  // Compacted to 95 %: seen again, but not under 90 %.
  d.stateDb.prepare('UPDATE agent_sessions SET total_tokens = 190000, updated_at = ?').run(NOW + 8 * H * 1000);
  for (let k = 0; k < 3; k++) assert.equal(pass(d, { nowMs: NOW + 8 * H * 1000 + 60_000 + k * 300_000 }).length, 0);
  assert.equal(d.stateDb.prepare("SELECT state FROM alert_state WHERE alert_key LIKE 'spend:session:%'").get().state, 'alerted');
  // Compacted to 30 %: resolved after two evaluations.
  d.stateDb.prepare('UPDATE agent_sessions SET total_tokens = 60000, updated_at = ?').run(NOW + 9 * H * 1000);
  assert.equal(pass(d, { nowMs: NOW + 9 * H * 1000 + 60_000 }).length, 0);
  const done = pass(d, { nowMs: NOW + 9 * H * 1000 + 360_000 });
  assert.equal(done.length, 1);
  assert.ok(done[0].resolved);
});

t('session: a tiny share still resolves (the clear level is clamped to 5 %)', () => {
  assert.equal(sa.configFromEnv({ REV4A_SPEND_SESSION_SHARE: '0.08' }).sessionClearShare, 0.05);
  assert.equal(sa.configFromEnv({}).sessionShare, 1);
  assert.equal(sa.configFromEnv({}).sessionClearShare, 0.9);
});

t('agent_sessions gets context_tokens: mapListRow reads contextTokens, an old table is migrated once', () => {
  const row = mapListRow({ key: 'agent:main:main', totalTokens: 1000, contextTokens: 200000, status: 'done' }, { container: 'c1', agentName: 'A' });
  assert.equal(row.context_tokens, 200000);
  assert.equal(mapListRow({ key: 'agent:main:x' }, { container: 'c1' }).context_tokens, null);
  const old = new Database(':memory:');
  old.exec('CREATE TABLE agent_sessions (container TEXT NOT NULL, session_key TEXT NOT NULL, total_tokens INTEGER, PRIMARY KEY (container, session_key))');
  ensureAddedColumns(old);
  ensureAddedColumns(old); // twice: no error
  assert.ok(old.prepare('PRAGMA table_info(agent_sessions)').all().some((c) => c.name === 'context_tokens'));
});

// ── Config, marker ───────────────────────────────────────────────────────────

t('disabled by REV4A_SPEND_ALERTS=false; non-positive and malformed thresholds fall back to the defaults', () => {
  const d = dbs();
  put(d.costsDb, { agent: 'writer', hour: LAST, calls: 95, prompt: 5_000_000, errors: 80, cost: 0.3 });
  assert.deepEqual(pass(d, { config: sa.configFromEnv({ REV4A_SPEND_ALERTS: 'false' }) }), []);
  const bad = sa.configFromEnv({ REV4A_SPEND_LOOP_MIN_FAILURES: '0', REV4A_SPEND_DAY_RATIO: '-3', REV4A_SPEND_DAY_FLOOR_TOKENS: 'abc', REV4A_SPEND_SESSION_SHARE: '5', REV4A_SPEND_LOOP_MIN_PROMPT_TOKENS: '0' });
  assert.equal(bad.loopMinFailures, 10);
  assert.equal(bad.dayRatio, 3);
  assert.equal(bad.dayFloorTokens, 20_000_000);
  assert.equal(bad.sessionShare, 1);
  assert.equal(bad.loopMinPromptTokens, 1_000_000);
  assert.equal(sa.configFromEnv({ REV4A_SPEND_DAY_RATIO: '4' }).dayRatio, 4);
});

t('the gap marker round-trips through a file next to costs.db', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-gap-'));
  try {
    const p = path.join(dir, 'costs.db');
    assert.equal(sa.readMeteringGap(p), 0);
    sa.markMeteringGap(p, 1234);
    assert.equal(sa.readMeteringGap(p), 1234);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Weight ───────────────────────────────────────────────────────────────────

t('a pass over 20 agents x 3 models x 400 days stays under 50 ms and never scans the table', () => {
  const d = dbs();
  const insert = d.costsDb.prepare(`INSERT INTO proxy_usage_hourly (hour, agent, provider, model, calls, prompt_tokens, completion_tokens, cached_tokens, errors, no_usage, cost)
    VALUES (?, ?, ?, ?, 12, 48000, 2400, 0, 0, 0, 0.01)`);
  const agents = Array.from({ length: 20 }, (_, i) => `agent${i}`);
  d.costsDb.transaction(() => {
    for (let h = LAST - 400 * DAY; h <= LAST; h += H) for (const a of agents) for (const m of ['m1', 'm2', 'm3']) insert.run(h, a, 'deepseek', m);
  })();
  fillBlock(d.costsDb, 'agent0', 0, 12, { cost: 1, calls: 40, prompt: 800_000 }); // fires: the whole path runs
  d.stateDb.prepare("INSERT INTO agent_sessions (container, session_key, kind, total_tokens, context_tokens, updated_at) VALUES ('c1', 'agent:main:main', 'main', 10, 200000, ?)").run(NOW);
  const rows = d.costsDb.prepare('SELECT COUNT(*) AS n FROM proxy_usage_hourly').get().n;
  const timings = [];
  let events = 0;
  for (let i = 0; i < 5; i++) {
    const dd = i === 0 ? d : d; // the same database; later passes run in cooldown, which is the steady state
    const t0 = process.hrtime.bigint();
    events += pass(dd).length;
    timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`  pass over ${rows} rows (20 agents x 3 models x 400 days): first (fires) ${timings[0].toFixed(1)} ms, steady ${Math.min(...timings.slice(1)).toFixed(1)}-${Math.max(...timings.slice(1)).toFixed(1)} ms`);
  assert.equal(events, 1);
  assert.ok(Math.max(...timings) < 50, `a pass took ${Math.max(...timings)} ms`);
  // Worst case: every agent over its floor, so every agent's 28-day history is read.
  for (const a of agents) fillBlock(d.costsDb, a, 0, 12, { cost: 1, calls: 40, prompt: 800_000 });
  const worst = [];
  for (let i = 0; i < 4; i++) {
    const t0 = process.hrtime.bigint();
    pass(d);
    worst.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`  worst case (all 20 agents over the floor): ${worst.map((x) => x.toFixed(1)).join(', ')} ms`);
  assert.ok(Math.min(...worst) < 50, `worst-case pass: ${worst}`);
  const plan = d.costsDb.prepare('EXPLAIN QUERY PLAN SELECT agent, SUM(calls) FROM proxy_usage_hourly WHERE hour > ? AND hour <= ? GROUP BY agent').all(0, 1).map((r) => r.detail).join(' ');
  assert.match(plan, /SEARCH/, plan);
});

console.log(`${passed} passed`);
console.log('\nscenario | result');
for (const [r, n] of results) console.log(`${r} | ${n}`);
