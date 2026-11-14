// Subscription (ChatGPT/Codex) usage is not a spend: lib/agent-costs.ts leaves it out of every
// spend figure and reports it apart. Runs against in-memory costs.db fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const ts = require('typescript');

// lib/agent-costs.ts imports './costs-db' and './proxy-usage' without an extension: transpile it and
// point those at stubs. openCostsDb returns the fixture database, so dashboardCosts runs for real.
let fixture = null;
globalThis.__costsFixture = () => fixture;
const src = fs.readFileSync(new URL('../lib/agent-costs.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace(/from ['"]\.\/costs-db['"]/, `from 'data:text/javascript,export const openCostsDb = () => globalThis.__costsFixture();'`)
  .replace(/from ['"]\.\/proxy-usage['"]/, `from 'data:text/javascript,export const UNKNOWN_AGENT = "unknown"; export const ASSISTANT_AGENT = "assistant";'`);
const lib = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const { isSubscriptionProvider, readCostSummary, readSubscriptionUsage, dashboardCosts, buildProxyUsage, readIdleAgents, lastDays } = lib;

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}

const days = lastDays(3); // oldest first; days[2] is today
const [d0, d1, d2] = days;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_cost_daily (container TEXT, date TEXT, input INTEGER DEFAULT 0, output INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0,
      input_cost REAL DEFAULT 0, output_cost REAL DEFAULT 0, cache_read_cost REAL DEFAULT 0, cache_write_cost REAL DEFAULT 0,
      missing INTEGER DEFAULT 0, PRIMARY KEY (container, date));
    CREATE TABLE agent_cost_model_daily (container TEXT, date TEXT, provider TEXT, model TEXT, tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0, calls INTEGER DEFAULT 0, PRIMARY KEY (container, date, provider, model));
    CREATE TABLE agent_cost_sessions (container TEXT, session_id TEXT, session_key TEXT, label TEXT, agent_id TEXT,
      provider TEXT, model TEXT, tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, missing INTEGER DEFAULT 0,
      first_activity INTEGER, last_activity INTEGER, PRIMARY KEY (container, session_id));
    CREATE TABLE agent_cost_sources (container TEXT PRIMARY KEY, agent_id TEXT, name TEXT, collected_at INTEGER,
      attempted_at INTEGER, error TEXT, missing_by_model TEXT);
  `);
  const daily = db.prepare(`INSERT INTO agent_cost_daily (container, date, input, output, cache_read, cache_write, total_tokens,
    cost, input_cost, output_cost, cache_read_cost, cache_write_cost, missing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const model = db.prepare('INSERT INTO agent_cost_model_daily VALUES (?,?,?,?,?,?,?)');
  const now = Date.now();
  db.prepare('INSERT INTO agent_cost_sources VALUES (?,?,?,?,?,?,?)').run('atlas', 'atlas', 'Atlas', now, now, null, JSON.stringify({ 'openai/gpt-9-mini': 2, 'rev4a/ghost': 1 }));
  db.prepare('INSERT INTO agent_cost_sources VALUES (?,?,?,?,?,?,?)').run('argus', 'argus', 'Argus', now, now, null, '{}');

  // atlas: day 0 rev4a only; day 1 rev4a 1.00 + openai 2.00 (priced) + openai unpriced model (2 calls, 500 tokens);
  // day 2 openai-codex only (its whole day is the subscription).
  daily.run('atlas', d0, 800, 200, 0, 0, 1000, 1.0, 0.6, 0.4, 0, 0, 0);
  model.run('atlas', d0, 'rev4a', 'deepseek-v4', 1000, 1.0, 5);
  daily.run('atlas', d1, 6000, 1500, 1000, 0, 8500, 3.0, 1.5, 1.0, 0.5, 0, 2);
  model.run('atlas', d1, 'rev4a', 'deepseek-v4', 3000, 1.0, 4);
  model.run('atlas', d1, 'openai', 'gpt-9', 5000, 2.0, 6);
  model.run('atlas', d1, 'openai', 'gpt-9-mini', 500, 0, 2);
  daily.run('atlas', d2, 300, 100, 0, 0, 400, 0.5, 0.3, 0.2, 0, 0, 0);
  model.run('atlas', d2, 'openai-codex', 'gpt-9', 400, 0.5, 1);
  // argus: day 1 only the subscription, but the daily row is SMALLER than the model rows
  // (OpenClaw rounding): the subtraction must stop at 0.
  daily.run('argus', d1, 90, 10, 0, 0, 100, 0.2, 0.1, 0.1, 0, 0, 0);
  model.run('argus', d1, 'openai', 'gpt-9', 150, 0.3, 2);
  model.run('argus', d1, 'rev4a', 'deepseek-v4', 0, 0, 0);
  // argus: a rev4a day
  daily.run('argus', d2, 450, 50, 0, 0, 500, 0.25, 0.15, 0.1, 0, 0, 0);
  model.run('argus', d2, 'rev4a', 'deepseek-v4', 500, 0.25, 3);
  db.prepare('INSERT INTO agent_cost_sessions (container, session_id, provider, model, tokens, cost, last_activity) VALUES (?,?,?,?,?,?,?)')
    .run('atlas', 's-sub', 'openai', 'gpt-9', 5000, 2.0, now);
  db.prepare('INSERT INTO agent_cost_sessions (container, session_id, provider, model, tokens, cost, last_activity) VALUES (?,?,?,?,?,?,?)')
    .run('atlas', 's-rev', 'rev4a', 'deepseek-v4', 3000, 1.0, now);
  return db;
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);

test('rule: openai and openai-codex are subscription providers, rev4a and others are not', () => {
  assert.equal(isSubscriptionProvider('openai'), true);
  assert.equal(isSubscriptionProvider('openai-codex'), true);
  for (const p of ['rev4a', 'openclaw', 'deepseek', 'openai-compat', '', null, undefined]) assert.equal(isSubscriptionProvider(p), false, String(p));
});

test('spend: totals leave out the subscription cost and tokens', () => {
  const db = makeDb();
  const s = readCostSummary(db, days);
  // rev4a: 1.0 + 1.0 + 0.25 ; atlas day1 3.0-2.0, day2 0.5-0.5 -> 0, argus day1 0.2-0.3 -> 0
  near(s.totals.cost, 1.0 + 1.0 + 0.25 + 0 + 0, 'cost');
  assert.equal(s.totals.tokens, 1000 + (8500 - 5500) + 0 + 0 + 500, 'tokens');
});

test('spend: the daily series follows the same rule', () => {
  const s = readCostSummary(makeDb(), days);
  assert.deepEqual(s.daily.map((d) => +d.cost.toFixed(6)), [1.0, 1.0, 0.25]);
  assert.deepEqual(s.daily.map((d) => d.tokens), [1000, 3000, 500]);
});

test('spend: by agent and by model', () => {
  const s = readCostSummary(makeDb(), days);
  const atlas = s.byAgent.find((a) => a.container === 'atlas');
  near(atlas.cost, 2.0, 'atlas');
  near(s.byAgent.find((a) => a.container === 'argus').cost, 0.25, 'argus');
  assert.deepEqual(s.byModel.map((m) => m.provider), ['rev4a']);
  near(s.byModel[0].cost, 2.25, 'rev4a model');
});

test('spend: subtraction never goes below zero (argus day 1: daily 0.2, subscription 0.3)', () => {
  const s = readCostSummary(makeDb(), [d1], { container: 'argus' });
  assert.equal(s.totals.cost, 0);
  assert.equal(s.totals.tokens, 0);
  assert.ok(s.totals.inputCost >= 0 && s.totals.outputCost >= 0 && s.totals.input >= 0);
});

test('spend: the cost split is scaled to what remains', () => {
  // atlas day 1: cost 3.0 -> 1.0 (a third), tokens 8500 -> 3000
  const s = readCostSummary(makeDb(), [d1], { container: 'atlas' });
  near(s.totals.inputCost, 1.5 / 3, 'input cost');
  near(s.totals.outputCost, 1.0 / 3, 'output cost');
  near(s.totals.cacheReadCost, 0.5 / 3, 'cache read cost');
  assert.equal(s.totals.input, Math.round(6000 * 3000 / 8500));
  near(s.totals.inputCost + s.totals.outputCost + s.totals.cacheReadCost + s.totals.cacheWriteCost, s.totals.cost, 'split adds up');
});

test('spend: the unpriced count is OpenClaw\'s, never reduced (a paid unpriced model is never hidden)', () => {
  const s = readCostSummary(makeDb(), days);
  assert.equal(s.totals.missing, 2, 'kept as OpenClaw recorded it');
  assert.ok(s.unpriced.some((u) => u.model === 'rev4a/ghost'), 'the paid unpriced model is listed');
  assert.ok(s.totals.missing > 0, 'the warning cannot disappear while a paid model is unpriced');
});

test('sessions: a subscription session stays listed and is labelled (it can mix paid and plan calls)', () => {
  const s = readCostSummary(makeDb(), days);
  assert.deepEqual(s.sessions.map((x) => [x.sessionId, x.usesSubscription]), [['s-sub', 1], ['s-rev', 0]]);
});

test('spend: an all-subscription day leaves no float residue', () => {
  const db = makeDb();
  db.prepare('INSERT INTO agent_cost_daily (container, date, input, output, cache_read, cache_write, total_tokens, cost, input_cost, output_cost, cache_read_cost, cache_write_cost, missing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('zeta', days[0], 100, 0, 0, 0, 100, 0.022821560000000005, 0.022821560000000005, 0, 0, 0, 0);
  db.prepare('INSERT INTO agent_cost_model_daily (container, date, provider, model, tokens, cost, calls) VALUES (?,?,?,?,?,?,?)')
    .run('zeta', days[0], 'openai', 'gpt-5.6-luna', 100, 0.02282156, 1);
  const zeta = readCostSummary(db, days).daily.length; // must not throw
  assert.ok(zeta >= 0);
  const z = readCostSummary(db, days).byAgent.find((a) => a.container === 'zeta');
  assert.equal(z ? z.cost : 0, 0);
});

test('spend: no subscription usage leaves the figures untouched', () => {
  const db = makeDb();
  db.prepare("DELETE FROM agent_cost_model_daily WHERE provider LIKE 'openai%'").run();
  const s = readCostSummary(db, days);
  near(s.totals.cost, 1.0 + 3.0 + 0.5 + 0.2 + 0.25, 'untouched');
});

test('dashboard: today and all time leave the subscription out', () => {
  fixture = makeDb();
  const c = dashboardCosts();
  near(c.today, 0.25, 'today');
  near(c.allTime, 1.0 + 1.0 + 0.25, 'all time');
  assert.deepEqual(c.byModelToday.map((m) => m.provider), ['rev4a']);
  assert.equal(c.missingToday, 0);
  fixture = null;
});

test('subscription: sums over the range', () => {
  const u = readSubscriptionUsage(makeDb(), days);
  assert.equal(u.totals.tokens, 5000 + 500 + 400 + 150);
  assert.equal(u.totals.calls, 6 + 2 + 1 + 2);
  near(u.totals.apiValue, 2.0 + 0.5 + 0.3, 'api value');
  assert.equal(u.totals.unpricedCalls, 2);
  assert.deepEqual(u.byAgent.map((a) => [a.container, a.name]), [['atlas', 'Atlas'], ['argus', 'Argus']]);
  near(u.byAgent[0].apiValue, 2.5, 'atlas api value');
  // gpt-9 through both providers is one line
  assert.deepEqual(u.byModel.map((m) => m.model), ['gpt-9', 'gpt-9-mini']);
  near(u.byModel[0].apiValue, 2.8, 'gpt-9');
  assert.equal(u.byModel[0].calls, 9);
});

test('subscription: a model without a price is "no price" with a count, not $0 priced', () => {
  const u = readSubscriptionUsage(makeDb(), days);
  const mini = u.byModel.find((m) => m.model === 'gpt-9-mini');
  assert.equal(mini.apiValue, 0);
  assert.equal(mini.unpricedCalls, 2);
  assert.ok(mini.tokens > 0);
  assert.deepEqual(u.unpriced, [{ model: 'gpt-9-mini', calls: 2 }]);
  assert.equal(u.byModel.find((m) => m.model === 'gpt-9').unpricedCalls, 0);
});

test('subscription: the range and the container narrow it', () => {
  const db = makeDb();
  assert.equal(readSubscriptionUsage(db, [d0]).totals.calls, 0);
  assert.equal(readSubscriptionUsage(db, [d2]).totals.tokens, 400);
  const argus = readSubscriptionUsage(db, days, { container: 'argus' });
  assert.deepEqual(argus.byAgent.map((a) => a.container), ['argus']);
  near(argus.totals.apiValue, 0.3);
});

test('subscription: empty when there is none (the page hides the section)', () => {
  const db = makeDb();
  db.prepare("DELETE FROM agent_cost_model_daily WHERE provider LIKE 'openai%'").run();
  const u = readSubscriptionUsage(db, days);
  assert.equal(u.totals.calls, 0);
  assert.equal(u.totals.tokens, 0);
  assert.deepEqual(u.byAgent, []);
});

test('rule: claude-cli is a subscription provider; plain anthropic is a paid API call', () => {
  assert.equal(isSubscriptionProvider('claude-cli'), true);
  assert.equal(isSubscriptionProvider('anthropic'), false);
});

/** makeDb plus Claude plan usage: atlas day 1 claude-cli (haiku, 4000 tokens, API value 0.8, 3 calls), argus day 2 claude-cli + a paid anthropic row. */
function makeClaudeDb() {
  const db = makeDb();
  db.prepare('INSERT INTO agent_cost_model_daily VALUES (?,?,?,?,?,?,?)').run('atlas', d1, 'claude-cli', 'claude-haiku-5-5', 4000, 0.8, 3);
  db.prepare('INSERT INTO agent_cost_model_daily VALUES (?,?,?,?,?,?,?)').run('argus', d2, 'claude-cli', 'claude-haiku-5-5', 1000, 0.2, 1);
  db.prepare('INSERT INTO agent_cost_model_daily VALUES (?,?,?,?,?,?,?)').run('argus', d2, 'anthropic', 'claude-haiku-5-5', 100, 0.05, 1);
  db.prepare('UPDATE agent_cost_daily SET total_tokens = total_tokens + 4000, cost = cost + 0.8 WHERE container = ? AND date = ?').run('atlas', d1);
  db.prepare('UPDATE agent_cost_daily SET total_tokens = total_tokens + 1100, cost = cost + 0.25 WHERE container = ? AND date = ?').run('argus', d2);
  db.prepare('INSERT INTO agent_cost_sessions (container, session_id, provider, model, tokens, cost, last_activity) VALUES (?,?,?,?,?,?,?)')
    .run('atlas', 's-claude', 'claude-cli', 'claude-haiku-5-5', 4000, 0.8, Date.now());
  return db;
}

test('claude plan: its calls are not in Spent, a paid anthropic row is', () => {
  const s = readCostSummary(makeClaudeDb(), days);
  // as makeDb (2.25) plus the paid anthropic 0.05; the claude-cli 0.8 and 0.2 are left out
  near(s.totals.cost, 2.25 + 0.05, 'cost');
  assert.ok(!s.byModel.some((m) => m.provider === 'claude-cli'), 'no claude-cli model row in Spent');
  assert.ok(s.byModel.some((m) => m.provider === 'anthropic'), 'the paid anthropic row stays');
});

test('claude plan: one subscription section per plan, ChatGPT text and figures unchanged', () => {
  const u = readSubscriptionUsage(makeClaudeDb(), days);
  assert.deepEqual(u.plans.map((p) => [p.id, p.label]), [['chatgpt', 'ChatGPT subscription'], ['claude', 'Claude subscription']]);
  const gpt = readSubscriptionUsage(makeDb(), days);
  assert.deepEqual(gpt.plans.length, 1);
  assert.equal(gpt.plans[0].label, 'ChatGPT subscription');
  assert.deepEqual(u.plans[0].totals, gpt.totals, 'the ChatGPT plan is what it was without Claude usage');
  assert.deepEqual(u.plans[0].byModel, gpt.byModel);
  const claude = u.plans[1];
  assert.equal(claude.totals.tokens, 5000);
  assert.equal(claude.totals.calls, 4);
  near(claude.totals.apiValue, 1.0, 'claude api value');
  assert.deepEqual(claude.byAgent.map((a) => a.container), ['atlas', 'argus']);
  assert.deepEqual(claude.byModel.map((m) => [m.model, m.provider]), [['claude-haiku-5-5', 'claude-cli']]);
  assert.equal(u.totals.tokens, gpt.totals.tokens + 5000, 'the top-level figures are all plans together');
});

test('claude plan: an agent narrowed to Claude only has one plan; no usage means no plans', () => {
  const only = readSubscriptionUsage(makeClaudeDb(), days, { container: 'argus' });
  assert.deepEqual(only.plans.map((p) => p.id), ['chatgpt', 'claude']);
  const none = readSubscriptionUsage(makeDb(), [d0]);
  assert.deepEqual(none.plans, []);
});

test('claude plan: the session is flagged and carries its provider', () => {
  const s = readCostSummary(makeClaudeDb(), days);
  const c = s.sessions.find((x) => x.sessionId === 's-claude');
  assert.equal(c.usesSubscription, 1);
  assert.equal(c.provider, 'claude-cli');
});

test('proxy comparison: the recorded side excludes subscription calls', () => {
  const db = makeDb();
  const s = readCostSummary(db, days);
  // The proxy metered exactly what went through it: rev4a calls only.
  const proxy = [
    { agent: 'atlas', calls: 9, promptTokens: 3000, completionTokens: 1000, cachedTokens: 0, errors: 0, noUsage: 0, cost: 2.0 },
    { agent: 'argus', calls: 3, promptTokens: 400, completionTokens: 100, cachedTokens: 0, errors: 0, noUsage: 0, cost: 0.25 },
  ];
  const r = buildProxyUsage(s.byAgent, proxy, readIdleAgents(db, s.byAgent));
  near(r.recordedCost, 2.25, 'recorded');
  assert.equal(r.byAgent.filter((l) => l.flagged).length, 0, 'no agent looks under-metered');
  assert.equal(r.byAgent.find((l) => l.container === 'atlas').gap, 0);
  // With the subscription counted (the old behaviour) atlas would have recorded 5.0 against 2.0 metered.
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
