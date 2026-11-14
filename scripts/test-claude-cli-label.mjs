#!/usr/bin/env node
/**
 * FEAT-25d: which cost and session rows ran on the Claude plan (lib/claude-cli-label.js), the way the
 * daemon stores them (replayed here on in-memory databases: daemon.js is never required), and the
 * read-back decision of the model writes (writeThenVerify).
 *
 *   node scripts/test-claude-cli-label.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const c = require('../lib/claude-cli-label.js');
const { writeThenVerify } = require('../lib/subscriptions-parse.js');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok  ${name}`); };

const cfg = (entry) => JSON.stringify({ agents: { defaults: { models: { 'anthropic/*': entry } } } });

await test('rule: read from openclaw.json exactly as Connect writes it', () => {
  assert.equal(c.claudeRuleFromConfigText(cfg({ agentRuntime: { id: 'claude-cli' } })), true);
  assert.equal(c.claudeRuleFromConfigText(cfg({ agentRuntime: { id: 'codex' } })), false);
  assert.equal(c.claudeRuleFromConfigText(cfg({})), false);
  assert.equal(c.claudeRuleFromConfigText('{}'), false);
  assert.equal(c.claudeRuleFromConfigText(JSON.stringify({ agents: { defaults: { models: { 'openai/*': { agentRuntime: { id: 'claude-cli' } } } } } })), false);
});

await test('rule: an unreadable config is unknown (null), never "off"', () => {
  for (const t of ['', '   ', 'not json', '[]', 'null', undefined, null, 5]) assert.equal(c.claudeRuleFromConfigText(t), null, String(t));
});

await test('intervals: on opens/touches, off closes at the LAST on-read date, unknown changes nothing', () => {
  const N = { open: null, reopen: null, touch: null, close: null, closeAt: null };
  const open = { since_date: '2026-11-01', until_date: null, last_on_date: '2026-11-12' };
  const closed = { since_date: '2026-10-01', until_date: '2026-10-05', last_on_date: '2026-10-05' };
  assert.deepEqual(c.planIntervalChange([], true, '2026-11-14'), { ...N, open: '2026-11-14' });
  assert.deepEqual(c.planIntervalChange([open], true, '2026-11-14'), { ...N, touch: '2026-11-01' });
  assert.deepEqual(c.planIntervalChange([closed], true, '2026-11-14'), { ...N, open: '2026-11-14' });
  assert.deepEqual(c.planIntervalChange([{ since_date: '2026-11-14', until_date: '2026-11-14', last_on_date: '2026-11-14' }], true, '2026-11-14'), { ...N, reopen: '2026-11-14' });
  assert.deepEqual(c.planIntervalChange([open], false, '2026-11-14'), { ...N, close: '2026-11-01', closeAt: '2026-11-12' });
  assert.deepEqual(c.planIntervalChange([{ since_date: '2026-11-01', until_date: null }], false, '2026-11-14'), { ...N, close: '2026-11-01', closeAt: '2026-11-01' });
  assert.deepEqual(c.planIntervalChange([closed], false, '2026-11-14'), N);
  assert.deepEqual(c.planIntervalChange([], false, '2026-11-14'), N);
  for (const list of [[], [open], [closed]]) assert.deepEqual(c.planIntervalChange(list, null, '2026-11-14'), N);
});

await test('label: only anthropic on a day the rule was on becomes claude-cli', () => {
  const on = [{ since_date: '2026-11-10', until_date: null, last_on_date: '2026-11-13' }];
  assert.equal(c.labelProvider('anthropic', '2026-11-12', on), 'claude-cli');
  assert.equal(c.labelProvider('anthropic', '2026-11-10', on), 'claude-cli');
  assert.equal(c.labelProvider('anthropic', '2026-11-13', on), 'claude-cli');
  assert.equal(c.labelProvider('anthropic', '2026-11-14', on), 'anthropic', 'after the last good read nothing is claimed');
  assert.equal(c.labelProvider('anthropic', '2026-11-12', on, 0), 'claude-cli');
  assert.equal(c.labelProvider('anthropic', '2026-11-12', on, null), 'claude-cli');
  assert.equal(c.labelProvider('anthropic', '2026-11-12', on, 0.02), 'anthropic', 'a priced row is paid API spend');
  assert.equal(c.labelProvider('anthropic', '2026-11-09', on), 'anthropic', 'before Connect: a paid call');
  assert.equal(c.labelProvider('anthropic', '2026-11-12', []), 'anthropic', 'rule never on');
  assert.equal(c.labelProvider('anthropic', null, on), 'anthropic', 'no date: untouched');
  for (const p of ['rev4a', 'openai', 'openai-codex', 'deepseek', 'claude-cli', null, undefined]) {
    assert.equal(c.labelProvider(p, '2026-11-12', on), p, String(p));
  }
  const ended = [{ since_date: '2026-11-10', until_date: '2026-11-12', last_on_date: '2026-11-12' }];
  assert.equal(c.labelProvider('anthropic', '2026-11-12', ended), 'claude-cli');
  assert.equal(c.labelProvider('anthropic', '2026-11-13', ended), 'anthropic', 'after Disconnect');
});

/**
 * One daemon pass for one container, as collectAgentCosts stores it: the interval change, then the
 * window of model rows rewritten from OpenClaw's own figures (cleared, then inserted), the sessions upserted.
 */
function makeStore() {
  const db = new Database(':memory:');
  db.exec(c.CREATE_TABLE_SQL);
  db.exec(`CREATE TABLE agent_cost_model_daily (container TEXT, date TEXT, provider TEXT, model TEXT, tokens INTEGER, cost REAL, calls INTEGER, PRIMARY KEY (container, date, provider, model));
    CREATE TABLE agent_cost_sessions (container TEXT, session_id TEXT, provider TEXT, tokens INTEGER, cost REAL, last_activity INTEGER, PRIMARY KEY (container, session_id));`);
  return db;
}
const util = (ms) => new Date(ms).toISOString().slice(0, 10);
function pass(db, { container = 'c1', state, today, openclawModelDaily, sessions = [] }) {
  const intervals = () => db.prepare('SELECT since_date, until_date, last_on_date FROM agent_cost_claude_cli WHERE container = ? ORDER BY since_date').all(container);
  db.transaction(() => {
    const ch = c.planIntervalChange(intervals(), state, today);
    if (ch.open) db.prepare('INSERT OR IGNORE INTO agent_cost_claude_cli VALUES (?, ?, NULL, ?)').run(container, ch.open, today);
    if (ch.reopen) db.prepare('UPDATE agent_cost_claude_cli SET until_date = NULL, last_on_date = ? WHERE container = ? AND since_date = ?').run(today, container, ch.reopen);
    if (ch.touch) db.prepare('UPDATE agent_cost_claude_cli SET last_on_date = ? WHERE container = ? AND since_date = ?').run(today, container, ch.touch);
    if (ch.close) db.prepare('UPDATE agent_cost_claude_cli SET until_date = ? WHERE container = ? AND since_date = ?').run(ch.closeAt, container, ch.close);
    const days = intervals();
    db.prepare('DELETE FROM agent_cost_model_daily WHERE container = ?').run(container); // the window covers every date used here
    for (const m of c.labelModelDaily(openclawModelDaily, days)) {
      db.prepare('INSERT OR REPLACE INTO agent_cost_model_daily VALUES (?,?,?,?,?,?,?)')
        .run(container, m.date, m.provider, m.model, m.tokens, m.cost, m.calls);
    }
    for (const s of sessions) {
      db.prepare('INSERT OR REPLACE INTO agent_cost_sessions VALUES (?,?,?,?,?,?)')
        .run(container, s.id, c.labelProvider(s.provider, util(s.last), days, s.cost), s.tokens, s.cost, s.last);
    }
  })();
}
const totals = (db) => db.prepare("SELECT provider, SUM(tokens) tokens, SUM(calls) calls FROM agent_cost_model_daily GROUP BY provider ORDER BY provider").all();
const D = (d) => `2026-11-${d}`;
const rows = [
  { date: D('08'), provider: 'anthropic', model: 'haiku', tokens: 100, cost: 0.1, calls: 1 }, // API, before Connect
  { date: D('12'), provider: 'anthropic', model: 'haiku', tokens: 400, cost: 0, calls: 2 },
  { date: D('12'), provider: 'rev4a', model: 'deepseek', tokens: 50, cost: 0.01, calls: 1 },
];

await test('store: rule on from the 10th labels only the days from then on, rev4a untouched', () => {
  const db = makeStore();
  pass(db, { state: false, today: D('09'), openclawModelDaily: rows.slice(0, 1) });
  pass(db, { state: true, today: D('10'), openclawModelDaily: rows });
  pass(db, { state: true, today: D('13'), openclawModelDaily: rows });
  assert.deepEqual(db.prepare('SELECT date, provider FROM agent_cost_model_daily ORDER BY date, provider').all(),
    [{ date: D('08'), provider: 'anthropic' }, { date: D('12'), provider: 'claude-cli' }, { date: D('12'), provider: 'rev4a' }]);
});

await test('store: no double counting across repeated passes, a Disconnect and a Connect', () => {
  const db = makeStore();
  const sum = () => db.prepare('SELECT SUM(tokens) t, SUM(calls) k FROM agent_cost_model_daily').get();
  const expect = { t: 550, k: 4 };
  pass(db, { state: true, today: D('10'), openclawModelDaily: rows });
  for (let i = 0; i < 3; i++) pass(db, { state: true, today: D('13'), openclawModelDaily: rows });
  assert.deepEqual(sum(), expect);
  pass(db, { state: false, today: D('13'), openclawModelDaily: rows }); // Disconnect
  assert.deepEqual(sum(), expect);
  pass(db, { state: true, today: D('13'), openclawModelDaily: rows }); // Connect again the same day
  assert.deepEqual(sum(), expect);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_cost_claude_cli').get().n, 2, 'an interval closed today and one opened today overlap harmlessly: the label is per date');
  pass(db, { state: false, today: D('14'), openclawModelDaily: rows });
  pass(db, { state: true, today: D('20'), openclawModelDaily: rows });
  assert.deepEqual(sum(), expect);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_cost_claude_cli').get().n, 3);
  // never one (date, model) under both labels
  assert.equal(db.prepare("SELECT COUNT(*) n FROM (SELECT date, model FROM agent_cost_model_daily WHERE provider IN ('anthropic','claude-cli') GROUP BY date, model HAVING COUNT(*) > 1)").get().n, 0);
});

await test('store: a failed read of the config (unknown) keeps the days, so the label does not flap', () => {
  const db = makeStore();
  pass(db, { state: true, today: D('10'), openclawModelDaily: rows });
  pass(db, { state: true, today: D('13'), openclawModelDaily: rows });
  pass(db, { state: null, today: D('14'), openclawModelDaily: rows });
  assert.deepEqual(db.prepare('SELECT since_date, until_date FROM agent_cost_claude_cli').all(), [{ since_date: D('10'), until_date: null }]);
  assert.equal(db.prepare('SELECT last_on_date l FROM agent_cost_claude_cli').get().l, D('13'), 'failed reads do not advance the last on-read');
  assert.equal(totals(db).find((t) => t.provider === 'claude-cli').tokens, 400);
});

await test('store: an agent that never had the rule is stored exactly as before; another container is independent', () => {
  const db = makeStore();
  pass(db, { state: false, today: D('13'), openclawModelDaily: rows });
  pass(db, { state: null, today: D('13'), openclawModelDaily: rows });
  assert.deepEqual(totals(db).map((t) => t.provider), ['anthropic', 'rev4a']);
  pass(db, { container: 'c2', state: true, today: D('10'), openclawModelDaily: rows });
  pass(db, { container: 'c2', state: true, today: D('13'), openclawModelDaily: rows });
  assert.deepEqual(db.prepare("SELECT provider FROM agent_cost_model_daily WHERE container = 'c1' AND provider = 'claude-cli'").all(), []);
  assert.ok(db.prepare("SELECT provider FROM agent_cost_model_daily WHERE container = 'c2' AND provider = 'claude-cli'").get());
});

await test('store: a session takes the label of the day of its last activity and keeps one row', () => {
  const db = makeStore();
  const at = (d) => Date.parse(`2026-11-${d}T12:00:00Z`);
  const s = (id, last) => ({ id, provider: 'anthropic', tokens: 10, cost: 0, last });
  pass(db, { state: true, today: D('10'), openclawModelDaily: [], sessions: [s('old', at('08')), s('new', at('12'))] });
  pass(db, { state: true, today: D('13'), openclawModelDaily: [], sessions: [s('old', at('08')), s('new', at('12'))] });
  assert.deepEqual(db.prepare('SELECT session_id, provider FROM agent_cost_sessions ORDER BY session_id').all(),
    [{ session_id: 'new', provider: 'claude-cli' }, { session_id: 'old', provider: 'anthropic' }]);
});

await test('paid spend survives Connect/Disconnect: a priced anthropic row is never relabelled, and failed reads after Disconnect hide nothing', () => {
  const db = makeStore();
  const paid = (date, cost) => ({ date, provider: 'anthropic', model: 'haiku', tokens: 1000, cost, calls: 5 });
  const plan = (date) => ({ date, provider: 'anthropic', model: 'haiku', tokens: 300, cost: 0, calls: 2 });
  const all = [paid(D('09'), 20), plan(D('10')), paid(D('11'), 10), plan(D('12')), paid(D('13'), 30), paid(D('14'), 0.5)];
  pass(db, { state: true, today: D('10'), openclawModelDaily: all });
  pass(db, { state: true, today: D('12'), openclawModelDaily: all });
  pass(db, { state: false, today: D('13'), openclawModelDaily: all }); // Disconnect seen on the 13th
  for (const d of ['14', '15']) pass(db, { state: null, today: D(d), openclawModelDaily: all }); // failed reads
  const by = Object.fromEntries(db.prepare('SELECT date, provider FROM agent_cost_model_daily ORDER BY date').all().map((r) => [r.date, r.provider]));
  assert.deepEqual(by, { [D('09')]: 'anthropic', [D('10')]: 'claude-cli', [D('11')]: 'anthropic', [D('12')]: 'claude-cli', [D('13')]: 'anthropic', [D('14')]: 'anthropic' });
  assert.deepEqual(db.prepare('SELECT since_date, until_date, last_on_date FROM agent_cost_claude_cli').all(), [{ since_date: D('10'), until_date: D('12'), last_on_date: D('12') }]);
  const paidSum = db.prepare("SELECT SUM(cost) c FROM agent_cost_model_daily WHERE provider = 'anthropic'").get().c;
  assert.equal(paidSum, 20 + 10 + 30 + 0.5, 'every dollar stays in Spent');
});

await test('sessions: relabelled by day whatever their estimated cost (sessions never feed Spent); cron runs and list rows share one relabel', () => {
  const on = [{ since_date: D('10'), until_date: null, last_on_date: D('13') }];
  const at = (d) => Date.parse(`2026-11-${d}T12:00:00Z`);
  const rowsIn = [
    { provider: 'anthropic', updated_at: at('12'), cost_usd: null },
    { provider: 'anthropic', updated_at: at('12'), cost_usd: 0 },
    { provider: 'anthropic', updated_at: at('12'), cost_usd: 0.4 },
    { provider: 'anthropic', updated_at: at('09'), cost_usd: null },
    { provider: 'rev4a', updated_at: at('12'), cost_usd: null },
    { provider: null, updated_at: at('12'), cost_usd: null },
  ];
  assert.deepEqual(c.relabelSessionRows(rowsIn, on).map((r) => r.provider), ['claude-cli', 'claude-cli', 'claude-cli', 'anthropic', 'rev4a', null]);
  const cron = [{ provider: 'anthropic', updated_at: at('13'), cost_usd: null }];
  assert.equal(c.relabelSessionRows(cron, on)[0].provider, 'claude-cli');
  assert.equal(c.relabelSessionRows([{ provider: 'anthropic', updated_at: at('13'), cost_usd: null }], [])[0].provider, 'anthropic');
});

await test('model rows: a relabelled anthropic row and a native claude-cli row of one (date, model) are summed, none lost', () => {
  const on = [{ since_date: D('10'), until_date: null, last_on_date: D('13') }];
  const out = c.labelModelDaily([
    { date: D('12'), provider: 'anthropic', model: 'haiku', tokens: 100, cost: 0, calls: 1 },
    { date: D('12'), provider: 'claude-cli', model: 'haiku', tokens: 40, cost: 0, calls: 2 },
    { date: D('12'), provider: 'anthropic', model: 'sonnet', tokens: 7, cost: 0.1, calls: 1 },
  ], on);
  assert.equal(out.length, 2);
  const h = out.find((r) => r.model === 'haiku');
  assert.deepEqual([h.provider, h.tokens, h.calls], ['claude-cli', 140, 3]);
  assert.equal(out.find((r) => r.model === 'sonnet').provider, 'anthropic');
  const db = makeStore();
  pass(db, { state: true, today: D('10'), openclawModelDaily: [{ date: D('12'), provider: 'anthropic', model: 'haiku', tokens: 100, cost: 0, calls: 1 }, { date: D('12'), provider: 'claude-cli', model: 'haiku', tokens: 40, cost: 0, calls: 2 }] });
  assert.equal(db.prepare('SELECT SUM(tokens) t FROM agent_cost_model_daily').get().t, 140);
});

await test('agentUsesCodex: a claude-cli or anthropic primary is not Codex; openai and openai-codex still are', async () => {
  const ts = require('typescript');
  const fs = require('node:fs');
  const src = fs.readFileSync(new URL('../lib/credentials/runtime.ts', import.meta.url), 'utf8');
  let configText = '';
  globalThis.__cfg = () => configText;
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/from ['"]@\/lib\/docker-exec['"]/, `from 'data:text/javascript,export const dockerExecNoFail = async () => globalThis.__cfg();'`)
    .replace(/from ['"]@\/lib\/agent-costs['"]/, `from 'data:text/javascript,export const CHATGPT_PROVIDERS = ["openai", "openai-codex"];'`);
  const { agentUsesCodex } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const withPrimary = (p) => JSON.stringify({ agents: { defaults: { model: { primary: p } } } });
  for (const [p, want] of [['openai/gpt-5', true], ['openai-codex/x', true], ['claude-cli/haiku', false], ['anthropic/claude-haiku-5-5', false], ['rev4a/deepseek', false]]) {
    configText = withPrimary(p);
    assert.equal(await agentUsesCodex('c1'), want, p);
  }
});

await test('model write: exec fails but the read-back shows the model -> ok', async () => {
  assert.equal(await writeThenVerify(async () => { throw new Error('timed out'); }, async () => true), 'ok');
});

await test('model write: exec fails and the read-back shows another model -> exec-failed', async () => {
  assert.equal(await writeThenVerify(async () => { throw new Error('timed out'); }, async () => false), 'exec-failed');
});

await test('model write: exec ok but the read-back differs -> mismatch; ok and matching -> ok', async () => {
  assert.equal(await writeThenVerify(async () => 'done', async () => false), 'mismatch');
  assert.equal(await writeThenVerify(async () => 'done', async () => true), 'ok');
});

await test('model write: a read-back that throws is "not there", never a success', async () => {
  assert.equal(await writeThenVerify(async () => 'done', async () => { throw new Error('unreadable'); }), 'mismatch');
  assert.equal(await writeThenVerify(async () => { throw new Error('x'); }, async () => { throw new Error('unreadable'); }), 'exec-failed');
});

console.log(`\n${n} tests passed`);
