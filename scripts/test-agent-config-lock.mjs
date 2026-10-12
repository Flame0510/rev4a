#!/usr/bin/env node
/**
 * Tests for lib/agent-config-lock.ts: the per-agent queue every writer of an agent's
 * openclaw.json goes through. Pure: no Docker, no network.
 *
 *   node scripts/test-agent-config-lock.mjs
 */
import assert from 'node:assert/strict';
import { withAgentConfigLock } from '../lib/agent-config-lock.ts';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await test('writers on one container run one at a time, in call order', async () => {
  const log = [];
  let running = 0;
  let maxRunning = 0;
  const job = (name, ms) => withAgentConfigLock('c-order', async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
    running--;
    return name;
  });
  const out = await Promise.all([job('a', 30), job('b', 5), job('c', 1)]);
  assert.deepEqual(out, ['a', 'b', 'c']);
  assert.equal(maxRunning, 1);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

await test('a failing writer rejects its own caller and never blocks the next one', async () => {
  const first = withAgentConfigLock('c-fail', async () => { await sleep(5); throw new Error('boom'); });
  const second = withAgentConfigLock('c-fail', async () => 'second ran');
  await assert.rejects(first, /boom/);
  assert.equal(await second, 'second ran');
  assert.equal(await withAgentConfigLock('c-fail', async () => 'third ran'), 'third ran');
});

await test('a writer that throws synchronously is isolated too', async () => {
  const first = withAgentConfigLock('c-sync', () => { throw new Error('sync boom'); });
  const second = withAgentConfigLock('c-sync', async () => 'ok');
  await assert.rejects(first, /sync boom/);
  assert.equal(await second, 'ok');
});

await test('different containers do not wait for each other', async () => {
  let releaseA;
  const holdA = withAgentConfigLock('c-par-a', () => new Promise((r) => { releaseA = r; }));
  // B must finish while A still holds its own lock.
  const b = await withAgentConfigLock('c-par-b', async () => 'b done');
  assert.equal(b, 'b done');
  let aDone = false;
  void holdA.then(() => { aDone = true; });
  await sleep(5);
  assert.equal(aDone, false);
  releaseA('a done');
  assert.equal(await holdA, 'a done');
});

await test('the result of each writer is returned unchanged', async () => {
  const obj = { x: 1 };
  assert.equal(await withAgentConfigLock('c-res', async () => obj), obj);
});

await test('a holder past the limit is logged once and still waited for', async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const slow = withAgentConfigLock('c-slow', async () => { await sleep(60); return 'late'; }, 15);
    const next = withAgentConfigLock('c-slow', async () => 'after');
    assert.equal(await slow, 'late');
    assert.equal(await next, 'after');
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /c-slow/);
});

await test('the chain is shared through globalThis (every route bundle sees one queue)', async () => {
  assert.ok(globalThis.__rev4aAgentConfigLock?.chains instanceof Map);
  let release;
  const hold = withAgentConfigLock('c-global', () => new Promise((r) => { release = r; }));
  assert.ok(globalThis.__rev4aAgentConfigLock.chains.has('c-global'));
  await sleep(1); // the holder starts on a later tick
  release();
  await hold;
  await sleep(5);
  assert.equal(globalThis.__rev4aAgentConfigLock.chains.has('c-global'), false, 'idle chains are dropped');
});

console.log(`\n${passed} passed`);
