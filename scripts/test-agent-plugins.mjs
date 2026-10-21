#!/usr/bin/env node
/**
 * Tests for lib/agent-plugins.ts (the parser of `openclaw plugins list --json`, the sort, the cache).
 *
 *   node scripts/test-agent-plugins.mjs
 */
import assert from 'node:assert/strict';

const m = await import('../lib/agent-plugins.ts');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

const sample = {
  workspaceDir: '/root/.openclaw/workspace',
  workspaceScope: 'agent',
  registry: { source: 'persisted', diagnostics: [] },
  plugins: [
    {
      id: 'zeta', name: 'Zeta', version: '1.2.0', description: 'Last alphabetically', format: 'openclaw',
      source: '/opt/x', rootDir: '/opt/x', origin: 'bundled', trust: 'trusted', enabled: true, status: 'loaded',
      toolNames: ['a', 'b', 'c'], hookNames: ['h1'], channelIds: ['telegram'], providerIds: [], commands: [],
      dependencyStatus: 'ok',
    },
    {
      id: 'alpha', name: 'alpha tool', version: '0.1.0', description: 'First', origin: 'global', enabled: true,
      status: 'loaded', toolNames: [], hookNames: [], channelIds: [], providerIds: ['openai'],
    },
    { id: 'off-one', name: 'Off one', version: '2.0.0', description: 'Disabled', origin: 'bundled', enabled: false, status: 'disabled' },
    { id: 'Aaa-off', name: 'Aaa off', enabled: false },
  ],
};

test('a real sample shape becomes the compact shape', () => {
  const list = m.parsePluginsList(JSON.stringify(sample)).plugins;
  const zeta = list.find((p) => p.id === 'zeta');
  assert.deepEqual(zeta, {
    id: 'zeta', name: 'Zeta', version: '1.2.0', description: 'Last alphabetically', enabled: true,
    status: 'loaded', origin: 'bundled', tools: 3, hooks: 1, channels: ['telegram'], providers: [],
  });
});

test('sorted enabled first, then by name', () => {
  const ids = m.parsePluginsList(JSON.stringify(sample)).plugins.map((p) => p.id);
  assert.deepEqual(ids, ['alpha', 'zeta', 'Aaa-off', 'off-one']);
});

test('missing fields get safe defaults', () => {
  const [p] = m.parsePluginsList(JSON.stringify({ plugins: [{ id: 'bare' }] })).plugins;
  assert.deepEqual(p, {
    id: 'bare', name: 'bare', version: '', description: '', enabled: false, status: 'disabled',
    origin: '', tools: 0, hooks: 0, channels: [], providers: [],
  });
});

test('wrong types do not throw: counts and lists ignore non-arrays and non-strings', () => {
  const [p] = m.parsePluginsList(JSON.stringify({
    plugins: [{ id: 'odd', name: 5, version: 3, enabled: 'yes', toolNames: 'x', hookNames: null, channelIds: [1, 'ok', ''], providerIds: {} }],
  })).plugins;
  assert.equal(p.name, 'odd');
  assert.equal(p.version, '');
  assert.equal(p.enabled, false);
  assert.equal(p.tools, 0);
  assert.equal(p.hooks, 0);
  assert.deepEqual(p.channels, ['ok']);
  assert.deepEqual(p.providers, []);
});

test('entries without an id are left out', () => {
  const list = m.parsePluginsList(JSON.stringify({ plugins: [null, 'x', {}, { id: '  ' }, { id: 'ok' }] })).plugins;
  assert.deepEqual(list.map((p) => p.id), ['ok']);
});

test('an empty plugin list is a valid answer', () => {
  assert.deepEqual(m.parsePluginsList('{"plugins":[]}'), { plugins: [], truncated: false });
});

test('a warning line before the JSON is skipped', () => {
  const out = 'warning: something\n' + JSON.stringify(sample);
  assert.equal(m.parsePluginsList(out).plugins.length, 4);
});

test('garbage, empty and wrong-shape output throw', () => {
  assert.throws(() => m.parsePluginsList('not json at all'), /unreadable/);
  assert.throws(() => m.parsePluginsList('{ broken'), /unreadable/);
  assert.throws(() => m.parsePluginsList(''), /no plugin list/);
  assert.throws(() => m.parsePluginsList('   \n'), /no plugin list/);
  assert.throws(() => m.parsePluginsList('{"plugins":"x"}'), /unreadable/);
  assert.throws(() => m.parsePluginsList('[]'), /unreadable/);
  assert.throws(() => m.parsePluginsList('null'), /unreadable/);
});

test('the command is fixed argv for the plugins list', () => {
  assert.deepEqual(m.PLUGINS_LIST_ARGV, ['openclaw', 'plugins', 'list', '--json']);
  assert.equal(m.PLUGINS_TIMEOUT_MS, 60000);
});

test('the cache keeps an entry for its lifetime only', () => {
  let t = 1000;
  const c = new m.PluginsCache(60_000, () => t);
  const list = { plugins: [], truncated: false };
  assert.equal(c.get('a'), null);
  c.set('a', list);
  t += 59_999;
  assert.equal(c.get('a').plugins, list.plugins);
  t += 1;
  assert.equal(c.get('a'), null);
  c.set('b', list);
  c.delete('b');
  assert.equal(c.get('b'), null);
});

const json = JSON.stringify(sample);

test('log lines before and after the JSON are tolerated, braces in them too', () => {
  assert.equal(m.parsePluginsList('WARN {deprecated} flag\n' + json + '\nDone. {ok}\n').plugins.length, 4);
  assert.equal(m.parsePluginsList(json + '\nDone.').plugins.length, 4);
});

test('braces and escaped quotes inside strings do not end the object early', () => {
  const tricky = JSON.stringify({ plugins: [{ id: 'x', description: 'a } b \\" { c' }] });
  const [p] = m.parsePluginsList('log\n' + tricky + '\nlog').plugins;
  assert.equal(p.description, 'a } b \\" { c');
});

test('a braced log line with no plugins array is skipped, not taken for the list', () => {
  assert.throws(() => m.parsePluginsList('{"level":"warn"}\n{"other":1}'), /unreadable/);
});

test('a repeated id keeps the first entry', () => {
  const { plugins } = m.parsePluginsList(JSON.stringify({ plugins: [{ id: 'a', name: 'First' }, { id: 'a', name: 'Second' }] }));
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, 'First');
});

test('the description is cut at 500 chars', () => {
  const { plugins } = m.parsePluginsList(JSON.stringify({ plugins: [{ id: 'a', description: 'x'.repeat(5000) }] }));
  assert.equal(plugins[0].description.length, 500);
});

test('the list is capped at 2000 entries and flagged truncated', () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: `p${i}`, enabled: i % 2 === 0 }));
  const r = m.parsePluginsList(JSON.stringify({ plugins: many }));
  assert.equal(r.plugins.length, 2000);
  assert.equal(r.truncated, true);
  assert.equal(m.parsePluginsList(json).truncated, false);
});

test('fresh=1 is sent only when asked', () => {
  assert.equal(m.pluginsUrl('agent_1', false), '/api/plugins?agent=agent_1');
  assert.equal(m.pluginsUrl('agent_1', true), '/api/plugins?agent=agent_1&fresh=1');
  assert.equal(m.pluginsUrl('a b', false), '/api/plugins?agent=a%20b');
});

test('errors become short plugin messages and never carry stderr', () => {
  const secret = 'Failed to load config /home/node/.openclaw/openclaw.json: EACCES token=sk-abc123';
  const other = m.pluginsError(new Error(`docker exec c: exit 1 — ${secret}`), 'Atlas');
  assert.deepEqual(other, { status: 500, error: 'Could not list plugins' });
  assert.deepEqual(m.pluginsError(new Error('docker exec c: timed out'), 'Atlas'), { status: 502, error: 'Agent Atlas did not answer in time' });
  assert.deepEqual(m.pluginsError(new Error('Container abc is restarting'), 'Atlas'), { status: 502, error: 'Agent Atlas is not running' });
  assert.deepEqual(m.pluginsError(new Error('Docker is not available'), 'Atlas'), { status: 503, error: 'Docker is not available' });
  const old = m.pluginsError(new Error("docker exec c: exit 1 — error: unknown command 'plugins'"), 'Atlas');
  assert.equal(old.status, 502);
  assert.match(old.error, /cannot list plugins/);
  assert.ok(!old.error.includes('unknown command'));
});

console.log(`\n${passed} passed`);
