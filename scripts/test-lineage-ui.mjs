#!/usr/bin/env node
/**
 * Tests for the pure Lineage UI logic (lib/patterns/sessionPresentation.ts, ApiAdapter.ts):
 * the tree (two containers with the same keys, depth-3 sub-agents, cron runs), labels, state,
 * the filters, the old `?agent=` links and the event join. Fixtures only: no server, no network.
 *
 *   node scripts/test-lineage-ui.mjs
 */
import assert from 'node:assert/strict';
import * as P from '../lib/patterns/sessionPresentation.ts';
import { adaptSession, adaptEvent } from '../lib/patterns/ApiAdapter.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 86_400_000;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

function row(container, key, extra = {}) {
  return adaptSession({
    uid: `${container}|${key}`, container, agent_name: container === 'c1' ? 'Atlas' : 'Argus', session_key: key,
    kind: 'direct', parent_uid: null, status: 'done', started_at: NOW - MIN, updated_at: NOW - MIN, cost_usd: 0.01, ...extra,
  });
}

const MAIN1 = 'agent:main:main';
const sessions = [
  row('c1', MAIN1, { kind: 'main' }),
  row('c2', MAIN1, { kind: 'main', status: 'running' }),
  row('c1', 'agent:main:subagent:aaaaaa11', { kind: 'subagent', parent_uid: `c1|${MAIN1}`, parent_kind: 'spawn', status: 'running' }),
  row('c1', 'agent:main:subagent:bbbbbb22', { kind: 'subagent', parent_uid: 'c1|agent:main:subagent:aaaaaa11', parent_kind: 'spawn' }),
  row('c1', 'agent:main:subagent:cccccc33', { kind: 'subagent', parent_uid: 'c1|agent:main:subagent:bbbbbb22', parent_kind: 'spawn', status: 'failed' }),
  row('c1', 'agent:main:cron:job1', { kind: 'cron', cron_job_id: 'job1' }),
  row('c1', 'agent:main:cron:job1:run:run111', { kind: 'cron_run', cron_job_id: 'job1', parent_uid: 'c1|agent:main:cron:job1', parent_kind: 'cron' }),
  row('c1', 'dashboard:11111111-2222-3333-4444-555555555555', { kind: 'dashboard', parent_uid: `c1|${MAIN1}`, parent_kind: 'nav', started_at: NOW - 20 * DAY, updated_at: NOW - 20 * DAY }),
];
const agents = [
  { value: 'c1', label: 'Atlas', running: true },
  { value: 'c2', label: 'Argus', running: false },
];

function find(node, uid) {
  if (node.uid === uid) return node;
  for (const c of node.children ?? []) { const f = find(c, uid); if (f) return f; }
  return null;
}
function depthOf(node, uid, d = 0) {
  if (node.uid === uid) return d;
  for (const c of node.children ?? []) { const r = depthOf(c, uid, d + 1); if (r >= 0) return r; }
  return -1;
}

test('tree: containers are the roots, main below, sub-agents three deep, cron run under its job', () => {
  const t = P.buildSessionTree(sessions, agents, 'all');
  assert.deepEqual(t.children.map((n) => n.uid), ['__agent__:c1', '__agent__:c2']);
  assert.equal(t.children[0].name, 'Atlas');
  assert.equal(t.children[1].stopped, true);
  assert.equal(t.children[0].children[0].uid, `c1|${MAIN1}`);
  assert.equal(depthOf(t, 'c1|agent:main:subagent:cccccc33'), 5); // root>container>main>a>b>c
  assert.equal(find(t, 'c1|agent:main:cron:job1').children[0].uid, 'c1|agent:main:cron:job1:run:run111');
  assert.equal(find(t, 'c1|agent:main:cron:job1').children[0].name, 'Cron run run111');
});

test('tree: the same key in two containers stays two nodes', () => {
  const t = P.buildSessionTree(sessions, agents, 'all');
  assert.ok(find(t, `c1|${MAIN1}`));
  assert.ok(find(t, `c2|${MAIN1}`));
  assert.notEqual(find(t, `c1|${MAIN1}`), find(t, `c2|${MAIN1}`));
  assert.equal(find(t, 'c2|agent:main:subagent:aaaaaa11'), null);
});

test('tree: an agent filter keeps one container; a missing parent or a loop hangs from main', () => {
  const t = P.buildSessionTree(sessions, agents, 'c2');
  assert.deepEqual(t.children.map((n) => n.uid), ['__agent__:c2']);
  const odd = [
    row('c1', MAIN1, { kind: 'main' }),
    row('c1', 'agent:main:subagent:x', { kind: 'subagent', parent_uid: 'c1|agent:main:subagent:y', parent_kind: 'spawn' }),
    row('c1', 'agent:main:subagent:y', { kind: 'subagent', parent_uid: 'c1|agent:main:subagent:x', parent_kind: 'spawn' }),
    row('c1', 'agent:main:subagent:z', { kind: 'subagent', parent_uid: 'c1|gone', parent_kind: 'spawn' }),
  ];
  const t2 = P.buildSessionTree(odd, agents, 'all');
  const main = find(t2, `c1|${MAIN1}`);
  assert.ok(main.children.length >= 2);
  assert.ok(find(t2, 'c1|agent:main:subagent:z') && depthOf(t2, 'c1|agent:main:subagent:z') === 3);
});

test('tree: without main the sessions hang from the container; a removed container is listed', () => {
  const t = P.buildSessionTree([row('c9', 'dashboard:abcdef123', { kind: 'dashboard', gone_at: NOW })], agents, 'all');
  assert.equal(t.children[0].uid, '__agent__:c9');
  assert.equal(t.children[0].stopped, true);
  assert.equal(t.children[0].children.length, 1);
});

test('state: running is working, except in a gone container; failed is error', () => {
  assert.equal(P.sessionState({ status: 'running', gone_at: null }), 'working');
  assert.equal(P.sessionState({ status: 'running', gone_at: NOW }), 'idle');
  assert.equal(P.sessionState({ status: 'failed', gone_at: null }), 'error');
  assert.equal(P.sessionState({ status: 'aborted', gone_at: null }), 'aborted');
  assert.equal(P.sessionState({ status: '', gone_at: null }), 'idle');
});

test('labels: every key shape has a readable name', () => {
  const L = (session_key, kind, label = null, cron_job_id = null) => P.deriveSessionDisplayLabel({ session_key, kind, label, cron_job_id });
  assert.equal(L(MAIN1, 'main'), 'main');
  assert.equal(L('agent:main:subagent:abcdef12-0000', 'subagent'), 'Sub-agent abcdef');
  assert.equal(L('agent:main:cron:job-1234', 'cron'), 'Cron job123');
  assert.equal(L('agent:main:cron:job-1234:run:sess99', 'cron_run'), 'Cron run sess99');
  assert.equal(L('dashboard:11111111-2222-3333-4444-555555555555', 'dashboard'), 'Dashboard 111111');
  assert.equal(L('explicit:nightly', 'explicit'), 'Explicit nightly');
  assert.equal(L('agent:main:11111111-2222-3333-4444-555555555555', 'direct'), 'Session 111111');
  assert.equal(L(MAIN1, 'direct', 'Weekly report'), 'Weekly report');
  assert.equal(L('agent:main:subagent:abcdef12', 'subagent', 'agent:main:subagent:abcdef12'), 'Sub-agent abcdef');
});

test('adapter: ms timestamps, null cost stays null, legacy parent_id maps into the container', () => {
  const s = adaptSession({ container: 'c1', session_key: 'k', cost_usd: null, started_at: 1_700_000_000, updated_at: NOW, status: 'RUNNING', parent_id: 'p' });
  assert.equal(s.uid, 'c1|k');
  assert.equal(s.cost_usd, null);
  assert.equal(s.started_at, 1_700_000_000_000);
  assert.equal(s.updated_at, NOW);
  assert.equal(s.status, 'running');
  assert.equal(s.parent_uid, 'c1|p');
  assert.equal(adaptSession({ container: 'c1', session_key: 'k', parent_uid: null, parent_id: 'p' }).parent_uid, null);
  assert.equal(adaptSession({ container: 'c1', session_key: 'k', status: 'weird' }).status, '');
});

const cfg = (extra = {}) => ({ agent: 'all', showOnlyActive: false, showCron: true, period: '7d', ...extra });

test('filters: agent, period, active only, no cron', () => {
  const ids = (c) => P.filterSessions(sessions, cfg(c), NOW).map((s) => s.uid);
  assert.equal(ids({}).length, sessions.length - 1); // the 20-day-old dashboard session is out
  assert.equal(ids({ period: '30d' }).length, sessions.length);
  assert.equal(ids({ period: '1d' }).length, sessions.length - 1);
  assert.ok(ids({ agent: 'c2' }).every((u) => u.startsWith('c2|')));
  assert.deepEqual(ids({ showOnlyActive: true }).sort(), [`c1|agent:main:subagent:aaaaaa11`, `c2|${MAIN1}`].sort());
  assert.ok(!ids({ showCron: false }).some((u) => u.includes(':cron:')));
});

test('filters: a working session is kept whatever its age', () => {
  const old = row('c1', 'agent:main:subagent:old', { kind: 'subagent', status: 'running', started_at: NOW - 40 * DAY, updated_at: NOW - 40 * DAY });
  assert.equal(P.filterSessions([old], cfg({ period: '1d' }), NOW).length, 1);
});

test('expandWithParents: a kept sub-agent brings its whole path to main', () => {
  const leaf = sessions.filter((s) => s.uid === 'c1|agent:main:subagent:cccccc33');
  const got = P.expandWithParents(sessions, leaf).map((s) => s.uid);
  assert.deepEqual(got.sort(), [`c1|${MAIN1}`, 'c1|agent:main:subagent:aaaaaa11', 'c1|agent:main:subagent:bbbbbb22', 'c1|agent:main:subagent:cccccc33'].sort());
  assert.deepEqual(P.expandWithParents(sessions, []), []);
});

test('tree: a navigation parent draws no edge; the session hangs from main as a normal one', () => {
  const nav = [
    row('c1', MAIN1, { kind: 'main' }),
    row('c1', 'agent:main:subagent:c', { kind: 'subagent', parent_uid: `c1|${MAIN1}`, parent_kind: 'spawn' }),
    row('c1', 'agent:main:direct:d', { kind: 'direct', parent_uid: 'c1|agent:main:subagent:c', parent_kind: 'nav' }),
    row('c1', 'agent:main:dashboard:e', { kind: 'dashboard', parent_uid: `c1|${MAIN1}`, parent_kind: 'nav' }),
  ];
  const t = P.buildSessionTree(nav, agents, 'all');
  assert.equal(depthOf(t, 'c1|agent:main:direct:d'), 3, 'under main, not under the sub-agent');
  assert.equal(find(t, 'c1|agent:main:subagent:c').children.length, 0);
  assert.equal(depthOf(t, 'c1|agent:main:dashboard:e'), 3);
  // expandWithParents follows spawn edges only
  const got = P.expandWithParents(nav, nav.filter((s) => s.uid === 'c1|agent:main:direct:d')).map((s) => s.uid);
  assert.deepEqual(got, ['c1|agent:main:direct:d']);
});

test('cron hidden: a sub-agent of a cron run does not bring the cron rows back; it hangs from main with a hint', () => {
  const k = 'agent:main:cron:j';
  const all = [
    row('c1', MAIN1, { kind: 'main' }),
    row('c1', k, { kind: 'cron', cron_job_id: 'j' }),
    row('c1', `${k}:run:s`, { kind: 'cron_run', cron_job_id: 'j', parent_uid: `c1|${k}`, parent_kind: 'cron' }),
    row('c1', 'agent:main:subagent:q', { kind: 'subagent', parent_uid: `c1|${k}:run:s`, parent_kind: 'spawn' }),
  ];
  const visible = P.filterSessions(all, cfg({ showCron: false }), NOW);
  assert.deepEqual(visible.map((s) => s.uid).sort(), [`c1|${MAIN1}`, 'c1|agent:main:subagent:q']);
  const expanded = P.expandWithParents(all, visible, { showCron: false });
  assert.ok(!expanded.some((s) => s.uid.includes(':cron:j')), 'no cron row returns');
  const t = P.buildSessionTree(expanded, agents, 'all');
  assert.equal(depthOf(t, 'c1|agent:main:subagent:q'), 3);
  assert.equal(find(t, 'c1|agent:main:subagent:q').hint, 'from a cron run');
  // with cron shown the path is kept as before
  const shown = P.expandWithParents(all, all.filter((s) => s.kind === 'subagent'), { showCron: true }).map((s) => s.uid);
  assert.ok(shown.includes(`c1|${k}:run:s`) && shown.includes(`c1|${k}`));
});

test('old links: an agent name resolves from the session rows when /api/agents is down; unknown falls back to all', () => {
  assert.equal(P.resolveAgentFilter('Atlas', [], sessions), 'c1');
  assert.equal(P.resolveAgentFilter('argus', [], sessions), 'c2');
  assert.equal(P.resolveAgentFilter('c2', [], sessions), 'c2');
  assert.equal(P.resolveAgentFilter('ghost', [], sessions), 'all');
  assert.equal(P.resolveAgentFilter('ghost', [], []), 'all');
});

test('graph cost keeps its dollar sign', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../app/components/SessionTopology.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('`$${Number(value).toFixed(4)}`'), 'formatCost shows $');
  assert.ok(src.includes("'not priced'"));
});

test('old links: ?agent=<display name> maps to the container, unknown falls back to all', () => {
  assert.equal(P.resolveAgentFilter('Atlas', agents), 'c1');
  assert.equal(P.resolveAgentFilter('atlas', agents), 'c1');
  assert.equal(P.resolveAgentFilter('c2', agents), 'c2');
  assert.equal(P.resolveAgentFilter('ops', agents), 'all');
  assert.equal(P.resolveAgentFilter(null, agents), 'all');
});

test('agent options: a container with sessions but no agent is listed as removed', () => {
  const o = P.buildAgentOptions([{ container: 'c1', label: 'Atlas', running: true }], [row('c7', 'k')]);
  assert.deepEqual(o.map((a) => a.value), ['c1', 'c7']);
  assert.match(o[1].label, /removed/);
});

test('uid: parse and make round-trip; keys with colons survive', () => {
  assert.deepEqual(P.parseUid(P.makeUid('c1', 'agent:main:main')), { container: 'c1', key: 'agent:main:main' });
  assert.equal(P.parseUid('nocontainer'), null);
  assert.equal(P.parseUid('c1|'), null);
});

test('events: milliseconds (the *1000 bug), the agent named, container from data', () => {
  const ev = P.decorateEvents([
    adaptEvent({ id: 1, ts: NOW - MIN, session_id: MAIN1, type: 'session_started', data: JSON.stringify({ container: 'c2' }) }),
    adaptEvent({ id: 2, ts: NOW - 2 * MIN, session_id: 'agent:main:subagent:aaaaaa11', type: 'subagent_spawned', container: 'c1' }),
    adaptEvent({ id: 3, ts: NOW - 3 * MIN, session_id: 'system', type: 'system_anomaly' }),
  ], sessions);
  assert.equal(ev[0].ts, NOW - MIN);
  assert.equal(ev[0].agent_name, 'Argus');
  assert.equal(ev[0].container, 'c2');
  assert.equal(ev[1].agent_name, 'Atlas');
  assert.equal(ev[1].session_label, 'Sub-agent aaaaaa');
  assert.equal(ev[2].session_label, 'system');
  const vis = P.filterSessions(sessions, cfg({ agent: 'c1' }), NOW);
  const shown = ev.filter((e) => P.eventMatchesFilter(e, cfg({ agent: 'c1' }), vis, NOW));
  assert.deepEqual(shown.map((e) => e.id), [2]);
  // a one-day period keeps an event from a minute ago (with the old *1000 it was dropped)
  assert.ok(P.eventMatchesFilter(ev[1], cfg({ period: '1d' }), vis, NOW));
  assert.ok(!P.eventMatchesFilter({ ...ev[1], ts: NOW - 2 * DAY }, cfg({ period: '1d' }), vis, NOW));
});

// --- graph layout (LIN-8) ---
const texts = (n) => [P.truncateLabel(P.nodeLabel(n)), n._agentNode ? '' : '$0.0012'];
const mk = (name, children = []) => ({ uid: name, name, state: 'idle', children });
const rootOf = (kids) => ({ uid: '__root__', name: '', state: 'idle', _virtualRoot: true, children: kids });
function boxRect(b) {
  return { l: b.x - b.width / 2, r: b.x + b.width / 2, t: b.y - 8, b: b.y + P.COST_DY + 2 };
}
function overlaps(boxes) {
  const rs = boxes.filter((b) => !b.node._virtualRoot).map((b) => ({ ...boxRect(b), n: b.node.name }));
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], c = rs[j];
    if (a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b) return `${a.n} / ${c.n}`;
  }
  return null;
}

test('layout: spacing grows with the number of siblings and 40 siblings never overlap', () => {
  const heightOf = (n) => {
    const kids = Array.from({ length: n }, (_, i) => mk(`Session number ${i}`));
    const boxes = P.layoutTree(rootOf([mk('main', kids)]), texts);
    return { boxes, span: Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y)) };
  };
  assert.ok(heightOf(15).span > heightOf(5).span);
  assert.ok(heightOf(40).span >= 39 * P.NODE_BLOCK_HEIGHT);
  assert.equal(overlaps(heightOf(40).boxes), null);
});

test('layout: a 4-level chain of long labels never overlaps, parent left of child', () => {
  const long = (p) => `${p} ${'very long session label '.repeat(4)}`;
  const chain = mk(long('d3'));
  const tree = rootOf([mk(long('agent'), [mk(long('d1'), [mk(long('d2'), [chain, mk(long('d3b'))])])])]);
  const boxes = P.layoutTree(tree, texts);
  assert.equal(overlaps(boxes), null);
  const byName = (p) => boxes.find((b) => b.node.name.startsWith(p));
  assert.ok(byName('d1').x - byName('d1').width / 2 > byName('agent').x + byName('agent').width / 2);
  assert.ok(byName('d2').x - byName('d2').width / 2 > byName('d1').x + byName('d1').width / 2);
  assert.ok(boxes.every((b) => b.width <= P.LABEL_MAX_CHARS * P.LABEL_CHAR_WIDTH + 1));
});

test('layout: wide tree with grandchildren has no overlap and is deterministic', () => {
  const kids = Array.from({ length: 12 }, (_, i) => mk(`Branch ${i}`, Array.from({ length: i % 4 }, (_, j) => mk(`Leaf ${i}-${j}`))));
  const t = rootOf([mk('main', kids)]);
  const a = P.layoutTree(t, texts);
  assert.equal(overlaps(a), null);
  assert.deepEqual(P.layoutTree(t, texts).map((b) => [b.x, b.y]), a.map((b) => [b.x, b.y]));
});

test('labels: truncation keeps the full text on the node and ends with an ellipsis', () => {
  const full = 'Lineage test with sub-agents and a very long session name';
  const cut = P.truncateLabel(full);
  assert.ok(Array.from(cut).length <= P.LABEL_MAX_CHARS && cut.endsWith('…'));
  assert.equal(P.truncateLabel('short'), 'short');
  const node = mk(full);
  P.layoutTree(rootOf([node]), texts);
  assert.equal(node.name, full);
  assert.equal(P.nodeLabel({ ...mk('Atlas'), _agentNode: true, stopped: true }), 'Atlas (stopped)');
});

test('periods: PERIOD_MS and the cutoff of each', () => {
  assert.deepEqual(P.PERIOD_MS, { '15m': 15 * MIN, '1h': 60 * MIN, '6h': 360 * MIN, '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY });
  for (const [p, ms] of Object.entries(P.PERIOD_MS)) assert.equal(P.periodCutoff(p, NOW), NOW - ms);
  assert.equal(P.periodCutoff('all', NOW), 0);
});

test('periods: a session just inside / just outside 15m, 1h, 6h', () => {
  const at = (age) => row('c1', 'agent:main:subagent:p' + age, { kind: 'subagent', started_at: NOW - age, updated_at: NOW - age });
  for (const [p, ms] of [['15m', 15 * MIN], ['1h', 60 * MIN], ['6h', 360 * MIN]]) {
    assert.equal(P.filterSessions([at(ms - MIN)], cfg({ period: p }), NOW).length, 1, p + ' inside');
    assert.equal(P.filterSessions([at(ms + MIN)], cfg({ period: p }), NOW).length, 0, p + ' outside');
  }
  assert.equal(P.filterSessions([at(10 * MIN)], cfg({ period: '15m' }), NOW).length, 1);
  assert.equal(P.filterSessions([at(20 * MIN)], cfg({ period: '15m' }), NOW).length, 0);
});

test('periods: parsing, old links, garbage, default, remembered value', () => {
  for (const p of ['15m', '1h', '6h', '1d', '7d', '30d', 'all']) assert.equal(P.parsePeriod(p), p);
  assert.equal(P.parsePeriod('3d'), '7d');
  assert.equal(P.parsePeriod('15d'), '30d');
  for (const g of ['', null, undefined, 'x', '2h', 'toString', '__proto__']) assert.equal(P.parsePeriod(g), null);
  assert.equal(P.DEFAULT_PERIOD, '1d');
  assert.equal(P.resolvePeriod(null, null), '1d');
  assert.equal(P.resolvePeriod('garbage', 'garbage'), '1d');
  assert.equal(P.resolvePeriod(null, '6h'), '6h');
  assert.equal(P.resolvePeriod('15m', '6h'), '15m');
  assert.equal(P.resolvePeriod('3d', '6h'), '7d');
  assert.equal(P.resolvePeriod('garbage', '1h'), '1h');
});

test('options: the home page keeps 7d and never reads storage; Lineage uses 1d and remembers', () => {
  assert.deepEqual(P.resolveDashboardOptions(), { defaultPeriod: '7d', rememberPeriod: false });
  let reads = 0;
  const spy = () => { reads++; return '6h'; };
  assert.equal(P.startPeriod(null, spy), '7d');
  assert.equal(P.startPeriod(null, spy, {}), '7d');
  assert.equal(P.startPeriod('3d', spy), '7d');
  assert.equal(P.startPeriod('1h', spy), '1h');
  assert.equal(reads, 0, 'home never reads storage');
  const lin = { defaultPeriod: '1d', rememberPeriod: true };
  assert.equal(P.startPeriod(null, spy, lin), '6h');
  assert.equal(reads, 1);
  assert.equal(P.startPeriod('15m', spy, lin), '15m');
  assert.equal(P.startPeriod(null, () => 'junk', lin), '1d');
  assert.equal(P.startPeriod(null, () => null, lin), '1d');
});

test('options: the default period is left out of the URL (1d on Lineage, 7d on home)', () => {
  assert.equal(P.filterToParams(cfg({ period: '1d' }), '1d').toString(), '');
  assert.equal(P.filterToParams(cfg({ period: '7d' }), '1d').toString(), 'period=7d');
  assert.equal(P.filterToParams(cfg({ period: '7d' })).toString(), '');
  assert.equal(P.filterToParams(cfg({ period: '1d' })).toString(), 'period=1d');
  assert.equal(P.filterToParams(cfg({ period: '15m', showCron: false }), '1d').toString(), 'period=15m&cron=0');
});

test('clock: a 10-minute-old session is in 15m at T and out at T+6min with the same data', () => {
  const s = [row('c1', 'agent:main:subagent:old', { kind: 'subagent', started_at: NOW - 10 * MIN, updated_at: NOW - 10 * MIN })];
  const c = cfg({ period: '15m' });
  assert.equal(P.filterSessions(s, c, NOW).length, 1);
  assert.equal(P.filterSessions(s, c, NOW + 6 * MIN).length, 0);
  assert.ok(P.isShortPeriod('15m') && P.isShortPeriod('1h') && P.isShortPeriod('6h'));
  assert.ok(!P.isShortPeriod('1d') && !P.isShortPeriod('all'));
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
