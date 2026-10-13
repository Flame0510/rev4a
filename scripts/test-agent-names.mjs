#!/usr/bin/env node
/**
 * Tests for lib/agent-names.ts (AGENT_NAME parsing from `docker inspect` output, label fallback).
 *
 *   node scripts/test-agent-names.mjs
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooks = `
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const ROOT = ${JSON.stringify(root)};
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const base = ROOT + '/' + specifier.slice(2);
    for (const e of ['.ts', '.js']) if (existsSync(base + e)) return next(pathToFileURL(base + e).href, context);
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(root + '/'));

const m = await import('../lib/agent-names.ts');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

test('parses the container name and AGENT_NAME, dropping the leading slash', () => {
  const out = '/agent_2a3c3a07\tAGENT_NAME=test 2\n/agent_b1\tAGENT_NAME=Atlas\n';
  const names = m.parseAgentNames(out);
  assert.equal(names.get('agent_2a3c3a07'), 'test 2');
  assert.equal(names.get('agent_b1'), 'Atlas');
});

test('a container without AGENT_NAME or with a blank one is absent', () => {
  const names = m.parseAgentNames('/agent_a\n/agent_b\tAGENT_NAME=   \n/agent_c\tAGENT_NAME=Zed');
  assert.equal(names.has('agent_a'), false);
  assert.equal(names.has('agent_b'), false);
  assert.equal(names.get('agent_c'), 'Zed');
});

test('a name containing "=" keeps everything after the first one', () => {
  assert.equal(m.parseAgentNames('/c\tAGENT_NAME=a=b').get('c'), 'a=b');
});

test('empty output gives an empty map', () => {
  assert.equal(m.parseAgentNames('').size, 0);
});

test('the inspect template names only AGENT_NAME', () => {
  assert.ok(m.AGENT_NAME_INSPECT_FORMAT.includes('"AGENT_NAME"'));
  assert.ok(!m.AGENT_NAME_INSPECT_FORMAT.includes('TOKEN'));
});

test('agentLabel prefers the display name, then the container, then the fallback', () => {
  assert.equal(m.agentLabel('test 2', 'agent_x'), 'test 2');
  assert.equal(m.agentLabel('  ', 'agent_x'), 'agent_x');
  assert.equal(m.agentLabel(null, null), 'agent');
});

test('stored alert text: containers are found and rewritten to Name (container) at read time', () => {
  const msg = 'Container agent_2a3c3a07: 1000 processes; agent_deadbeef too';
  assert.deepEqual(m.containersInText(msg), ['agent_2a3c3a07', 'agent_deadbeef']);
  const out = m.nameContainersInText(msg, new Map([['agent_2a3c3a07', 'test 2']]));
  assert.equal(out, 'Container test 2 (agent_2a3c3a07): 1000 processes; agent_deadbeef too');
  assert.equal(m.describeAgent('agent_unknown'), 'agent_unknown');
});

test('container names are matched on boundaries only', () => {
  assert.deepEqual(m.containersInText('agent_2a3c3a0799 and xagent_2a3c3a07 and agent_2a3c3a07.'), ['agent_2a3c3a07']);
  assert.deepEqual(m.containersInText('(agent_2a3c3a07)'), ['agent_2a3c3a07']);
});

test('only valid container names are accepted', () => {
  for (const ok of ['agent_2a3c3a07', 'a', 'my-app.1']) assert.ok(m.CONTAINER_NAME_RE.test(ok), ok);
  for (const bad of ['', '-x', '--format', '.x', 'a b', 'a;b', '$(x)', '/etc']) assert.equal(m.CONTAINER_NAME_RE.test(bad), false, bad);
});

const map = (globalThis.__rev4aAgentNameMap ??= new Map());
const now = Date.now();
map.clear();
map.set('fresh_one', { name: 'Fresh', at: now, seen: now });
map.set('fresh_none', { name: null, at: now, seen: now });
map.set('stale_one', { name: 'Stale', at: now - 60_000, seen: now });
map.set('forgotten', { name: 'Old', at: now - 3_600_000, seen: now - 3_600_000 });

await test('per-entry cache: fresh entries are served without Docker, a remembered miss stays a miss', async () => {
  const got = await m.getAgentDisplayNames(['fresh_one', 'fresh_none', '--format', 'bad name']);
  assert.equal(got.get('fresh_one'), 'Fresh');
  assert.equal(got.has('fresh_none'), false);
  assert.equal(got.size, 1);
});

test('cachedAgentName honours the TTL and never runs Docker', () => {
  assert.equal(m.cachedAgentName('fresh_one'), 'Fresh');
  assert.equal(m.cachedAgentName('stale_one'), null);
  assert.equal(m.cachedAgentName('never_seen'), null);
  assert.equal(m.describeAgent('fresh_one'), 'Fresh (fresh_one)');
  assert.equal(m.describeAgent('stale_one'), 'stale_one');
});

test('entries not seen for 10 minutes are dropped', () => {
  assert.equal(map.has('forgotten'), false);
});

{
  assert.equal((await m.getAgentDisplayNames([])).size, 0); passed++; console.log("ok   no containers asks nothing and returns an empty map");
}
console.log(`\n${passed} passed`);
