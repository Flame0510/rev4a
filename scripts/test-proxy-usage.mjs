import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseAgentHeader, extractUsage, usageFromBody, createSseUsageParser, costAt, hourBucket, buildEntry, createAgentResolver, UNKNOWN_AGENT, ASSISTANT_AGENT,
} = require('../lib/proxy-usage.js');

// lib/agent-costs.ts imports './costs-db' without an extension, which Node's type stripping
// cannot resolve: transpile it here and point that import at a stub (buildProxyUsage is pure).
// './proxy-usage' gets the real constants, in the same way.
const ts = require('typescript');
const src = fs.readFileSync(new URL('../lib/agent-costs.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace(/from ['"]\.\/costs-db['"]/, `from 'data:text/javascript,export const openCostsDb = () => null;'`)
  .replace(/from ['"]\.\/proxy-usage['"]/, `from 'data:text/javascript,${encodeURIComponent(`export const UNKNOWN_AGENT = ${JSON.stringify(UNKNOWN_AGENT)}; export const ASSISTANT_AGENT = ${JSON.stringify(ASSISTANT_AGENT)};`)}'`);
const { buildProxyUsage } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

test('header: an agent id passes, anything else is unknown', () => {
  assert.equal(parseAgentHeader('atlas-1'), 'atlas-1');
  assert.equal(parseAgentHeader('  atlas_1.b  '), 'atlas_1.b');
  assert.equal(parseAgentHeader(null), 'unknown');
  assert.equal(parseAgentHeader(undefined), 'unknown');
  assert.equal(parseAgentHeader(''), 'unknown');
  assert.equal(parseAgentHeader('a b'), 'unknown');
  assert.equal(parseAgentHeader("a'; DROP"), 'unknown');
  assert.equal(parseAgentHeader('x'.repeat(65)), 'unknown');
  assert.equal(parseAgentHeader(['a', 'b']), 'unknown');
});

test('usage: OpenAI shape with cached tokens', () => {
  const u = extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } });
  assert.deepEqual(u, { prompt: 100, completion: 20, cached: 60 });
});

test('usage: DeepSeek cache hit field', () => {
  const u = extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } });
  assert.deepEqual(u, { prompt: 100, completion: 5, cached: 80 });
});

test('usage: cached never exceeds the prompt; missing or bad fields are zero', () => {
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 99 } }), { prompt: 10, completion: 1, cached: 10 });
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 10 } }), { prompt: 10, completion: 0, cached: 0 });
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: -3, completion_tokens: 4 } }), { prompt: 0, completion: 4, cached: 0 });
});

test('usage: none when there is no usage block', () => {
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage(null), null);
  assert.equal(extractUsage({ usage: null }), null);
  assert.equal(extractUsage({ usage: {} }), null);
  assert.equal(extractUsage({ usage: 'x' }), null);
});

test('usage: from a JSON body, and from one that is not JSON', () => {
  assert.deepEqual(usageFromBody('{"id":"1","usage":{"prompt_tokens":7,"completion_tokens":3}}'), { prompt: 7, completion: 3, cached: 0 });
  assert.equal(usageFromBody('<html>502</html>'), null);
  assert.equal(usageFromBody('{"error":{"message":"bad"}}'), null);
});

const SSE = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":9,"prompt_cache_hit_tokens":40}}\n\n',
  'data: [DONE]\n\n',
].join('');

test('sse: one chunk', () => {
  const p = createSseUsageParser();
  p.push(SSE);
  assert.deepEqual(p.end(), { prompt: 50, completion: 9, cached: 40 });
});

test('sse: split at every possible offset', () => {
  for (let i = 1; i < SSE.length; i++) {
    const p = createSseUsageParser();
    p.push(SSE.slice(0, i));
    p.push(SSE.slice(i));
    assert.deepEqual(p.end(), { prompt: 50, completion: 9, cached: 40 }, `split at ${i}`);
  }
});

test('sse: one character at a time, CRLF line ends', () => {
  const p = createSseUsageParser();
  for (const ch of SSE.replace(/\n/g, '\r\n')) p.push(ch);
  assert.deepEqual(p.end(), { prompt: 50, completion: 9, cached: 40 });
});

test('sse: the last line without a newline is read by end()', () => {
  const p = createSseUsageParser();
  p.push('data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}');
  assert.deepEqual(p.end(), { prompt: 1, completion: 2, cached: 0 });
});

test('sse: a stream cut before the usage chunk reports none', () => {
  const p = createSseUsageParser();
  p.push(SSE.split('\n\n').slice(0, 2).join('\n\n') + '\n\n');
  assert.equal(p.end(), null);
});

test('sse: noise lines and garbage JSON are ignored', () => {
  const p = createSseUsageParser();
  p.push(': keep-alive\n\nevent: ping\ndata: {not json "usage"\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\n');
  assert.deepEqual(p.end(), { prompt: 2, completion: 2, cached: 0 });
});

test('sse: a huge line without a newline is dropped, not buffered forever', () => {
  const p = createSseUsageParser();
  p.push('data: ' + 'x'.repeat(2 * 1024 * 1024));
  p.push('\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n');
  assert.deepEqual(p.end(), { prompt: 1, completion: 1, cached: 0 });
});

// Rates in $ per 1M tokens; the off-peak band is half of peak (priceAt applies it).
const PEAK = { input: 0.28, output: 1.1, cacheRead: 0.028 };
const OFF = { input: 0.14, output: 0.55, cacheRead: 0.014 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('cost: cached part at the cache rate, the rest of the prompt at input', () => {
  close(costAt({ prompt: 1_000_000, completion: 100_000, cached: 400_000 }, PEAK), 0.6 * 0.28 + 0.4 * 0.028 + 0.1 * 1.1);
});

test('cost: the rates of the moment decide (peak twice off-peak)', () => {
  const u = { prompt: 2_000_000, completion: 1_000_000, cached: 0 };
  close(costAt(u, PEAK), 2 * costAt(u, OFF));
});

test('cost: no rates or no usage is zero; a missing cache rate falls back to input', () => {
  assert.equal(costAt({ prompt: 5, completion: 5, cached: 0 }, null), 0);
  assert.equal(costAt(null, PEAK), 0);
  close(costAt({ prompt: 1_000_000, completion: 0, cached: 1_000_000 }, { input: 2, output: 4 }), 2);
});

test('hour: bucket is the UTC hour start in epoch seconds', () => {
  assert.equal(hourBucket(Date.UTC(2026, 9, 7, 13, 59, 59, 999)), Date.UTC(2026, 9, 7, 13) / 1000);
  assert.equal(hourBucket(Date.UTC(2026, 9, 7, 14)), Date.UTC(2026, 9, 7, 14) / 1000);
});

test('entry: a successful call', () => {
  const at = Date.UTC(2026, 9, 7, 8, 30);
  const e = buildEntry({ atMs: at, agent: 'atlas', provider: 'deepseek', model: 'deepseek-flash', status: 200,
    usage: { prompt: 1_000_000, completion: 0, cached: 0 }, rates: PEAK });
  assert.equal(e.hour, Date.UTC(2026, 9, 7, 8) / 1000);
  assert.equal(e.calls, 1);
  assert.equal(e.errors, 0);
  assert.equal(e.no_usage, 0);
  assert.equal(e.prompt_tokens, 1_000_000);
  close(e.cost, 0.28);
});

test('entry: an error is counted as one, without tokens or cost', () => {
  const e = buildEntry({ atMs: 0, agent: 'unknown', provider: 'deepseek', model: 'm', status: 429, usage: null, rates: PEAK });
  assert.deepEqual([e.calls, e.errors, e.no_usage, e.cost, e.prompt_tokens], [1, 1, 0, 0, 0]);
  assert.equal(buildEntry({ atMs: 0, agent: 'a', provider: 'p', model: 'm', status: 0, usage: null, rates: null }).errors, 1);
});

test('entry: a success without usage is flagged, not billed', () => {
  const e = buildEntry({ atMs: 0, agent: 'a', provider: 'p', model: 'm', status: 200, usage: null, rates: PEAK });
  assert.deepEqual([e.errors, e.no_usage, e.cost], [0, 1, 0]);
});

test('header: assistant and unknown are reserved', () => {
  assert.equal(parseAgentHeader('assistant'), 'unknown');
  assert.equal(parseAgentHeader('unknown'), 'unknown');
  assert.equal(parseAgentHeader(' assistant '), 'unknown');
  assert.equal(parseAgentHeader('Assistant'), 'unknown');
  assert.equal(parseAgentHeader('UNKNOWN'), 'unknown');
  assert.equal(parseAgentHeader('assistant2'), 'assistant2');
});

test('resolver: known ids always pass; others share the hourly cap', () => {
  const r = createAgentResolver({ loadKnown: () => ['atlas', 'atlas-container'], now: () => 0, maxUnverified: 1 });
  assert.equal(r('atlas'), 'atlas');
  assert.equal(r('atlas-container'), 'atlas-container');
  assert.equal(r('new-agent'), 'new-agent');
  assert.equal(r('stranger'), 'unknown');
  assert.equal(r('atlas'), 'atlas');
  assert.equal(r('assistant'), 'unknown');
  assert.equal(r(null), 'unknown');
});

test('resolver: the known set is read at most once per minute', () => {
  let t = 1000, loads = 0, set = ['a'];
  const r = createAgentResolver({ loadKnown: () => { loads++; return set; }, now: () => t });
  for (let i = 0; i < 50; i++) r('a');
  assert.equal(loads, 1);
  set = ['a', 'b'];
  t += 59_000;
  r('b');
  assert.equal(loads, 1);
  t += 2_000;
  assert.equal(r('b'), 'b');
  assert.equal(loads, 2);
});

test('resolver: token identities require known ids and cannot borrow or consume the legacy allowance', () => {
  let t = 0;
  let known = ['atlas'];
  const r = createAgentResolver({ loadKnown: () => known, now: () => t, maxUnverified: 1 });
  assert.equal(r('atlas', true), 'atlas');
  assert.equal(r('never-known', true), 'unknown');
  assert.equal(r('new-legacy'), 'new-legacy');
  assert.equal(r('new-legacy', true), 'unknown');
  assert.equal(r('another'), 'unknown');
  known = [];
  t += 60_001;
  assert.equal(r('atlas', true), 'unknown');
  const unreadable = createAgentResolver({ loadKnown: () => { throw new Error('unavailable'); } });
  assert.equal(unreadable('atlas', true), 'unknown');
  assert.equal(unreadable('atlas'), 'atlas');
});

test('resolver: explicit source removal refreshes at 60000 ms; unknown tokens preserve all 200 legacy slots', () => {
  let t = 0, loads = 0;
  let known = ['atlas'];
  const r = createAgentResolver({ loadKnown: () => { loads++; return known; }, now: () => t });
  assert.equal(r('atlas', true), 'atlas');
  // Explicit source maintenance, not agent deletion (deletion retains history).
  known = [];
  for (const [time, expected, expectedLoads] of [[59_999, 'atlas', 1], [60_000, 'unknown', 2], [60_001, 'unknown', 2]]) {
    t = time;
    assert.equal(r('atlas', true), expected);
    assert.equal(loads, expectedLoads);
    console.log(`     TTL ${time}: ${expected}, loads=${loads}`);
  }
  for (let i = 0; i < 1000; i++) assert.equal(r('token' + i, true), 'unknown');
  for (let i = 1; i <= 200; i++) assert.equal(r('legacy' + i), 'legacy' + i);
  assert.equal(r('legacy201'), 'unknown');
  console.log('     1000 unknown token calls; legacy 199=legacy199 200=legacy200 201=unknown');
});

test('resolver: an unreadable or empty known set accepts at most 200 distinct ids per hour', () => {
  for (const loadKnown of [() => { throw new Error('locked'); }, () => []]) {
    let t = Date.UTC(2026, 9, 7, 10, 5);
    const r = createAgentResolver({ loadKnown, now: () => t });
    for (let i = 0; i < 200; i++) assert.equal(r('id' + i), 'id' + i);
    assert.equal(r('id200'), 'unknown');
    assert.equal(r('id5'), 'id5');
    assert.equal(r('assistant'), 'unknown');
    t = Date.UTC(2026, 9, 7, 11, 0);
    assert.equal(r('id200'), 'id200');
  }
});

const agentRow = (over) => ({ container: 'c-atlas', agentId: 'atlas', name: 'Atlas', cost: 0, tokens: 0, missing: 0,
  collectedAt: null, attemptedAt: null, error: null, ...over });
const proxyRow = (agent, cost, calls = 1) => ({ agent, calls, promptTokens: 0, completionTokens: 0, cachedTokens: 0, errors: 0, noUsage: 0, cost });

test('buildProxyUsage: rows under agentId and container name are merged into one agent', () => {
  const s = buildProxyUsage([agentRow({ cost: 10, tokens: 100 })], [proxyRow('atlas', 3, 4), proxyRow('c-atlas', 2, 5)]);
  assert.equal(s.byAgent.length, 1);
  const l = s.byAgent[0];
  assert.equal(l.metered.cost, 5);
  assert.equal(l.metered.calls, 9);
  assert.equal(l.combined, 10);
  assert.equal(s.combinedCost, 10);
  assert.equal(s.meteredCost, 5);
});

test('buildProxyUsage: an agent whose agentId equals its container is not counted twice', () => {
  const s = buildProxyUsage([agentRow({ container: 'x', agentId: 'x', cost: 1, tokens: 1 })], [proxyRow('x', 4)]);
  assert.equal(s.byAgent.length, 1);
  assert.equal(s.byAgent[0].metered.cost, 4);
});

test('buildProxyUsage: unknown and assistant are listed but never flagged', () => {
  const s = buildProxyUsage([agentRow({ cost: 1, tokens: 1 })], [proxyRow('unknown', 50), proxyRow('assistant', 50), proxyRow('atlas', 50)]);
  const by = Object.fromEntries(s.byAgent.map((l) => [l.metered.agent, l]));
  assert.equal(by.unknown.flagged, false);
  assert.equal(by.assistant.flagged, false);
  assert.equal(by.atlas.flagged, true);
});

test('buildProxyUsage: unknown keeps its figures but adds nothing to Spent; assistant is added', () => {
  const s = buildProxyUsage([agentRow({ cost: 1, tokens: 1 })], [proxyRow('unknown', 50), proxyRow('assistant', 7), proxyRow('atlas', 3)]);
  const by = Object.fromEntries(s.byAgent.map((l) => [l.metered.agent, l]));
  assert.equal(by.unknown.metered.cost, 50);
  assert.equal(by.unknown.combined, 0);
  assert.equal(by.assistant.combined, 7);
  assert.equal(by.atlas.combined, 3);
  assert.equal(s.combinedCost, 10);
  assert.equal(s.meteredCost, 60);
});

test('buildProxyUsage: duplicate rows for one caller are summed, not replaced', () => {
  const s = buildProxyUsage([], [proxyRow('a', 5), proxyRow('a', 7, 2)]);
  assert.equal(s.byAgent.length, 1);
  assert.equal(s.byAgent[0].metered.cost, 12);
  assert.equal(s.byAgent[0].metered.calls, 3);
});

test('store: before the daemon made agent_cost_sources the known read fails, the metering does not', () => {
  const Database = require('better-sqlite3');
  const { CREATE_TABLE_SQL } = require('../lib/proxy-usage.js');
  const db = new Database(':memory:');
  db.exec(CREATE_TABLE_SQL);
  const read = () => db.prepare('SELECT agent_id, container FROM agent_cost_sources').all();
  assert.throws(read);
  const r = createAgentResolver({ loadKnown: read, now: () => 0 });
  assert.equal(r('new-agent'), 'new-agent');
});

test('buildProxyUsage: an idle agent the proxy saw is named and flagged, not a bare proxy: line', () => {
  const idle = [agentRow({ container: 'bob', agentId: 'agent_b', name: 'Bob', cost: 0, tokens: 0 })];
  const s = buildProxyUsage([], [proxyRow('agent_b', 5)], idle);
  assert.equal(s.byAgent.length, 1);
  assert.equal(s.byAgent[0].key, 'bob');
  assert.equal(s.byAgent[0].name, 'Bob');
  assert.equal(s.byAgent[0].flagged, true);
  assert.equal(buildProxyUsage([], [], idle).byAgent.length, 0);
});

test('buildProxyUsage: an agent literally named unknown keeps its recorded spend', () => {
  const s = buildProxyUsage([agentRow({ container: 'unknown', agentId: 'unknown', name: 'U', cost: 20, tokens: 1 })], [proxyRow('unknown', 3)]);
  assert.equal(s.combinedCost, 20);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
