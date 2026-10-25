#!/usr/bin/env node
/**
 * Tests for lib/gateway-state.ts (the Gateway state shown on the Agents page).
 *
 *   node scripts/test-gateway-state.mjs
 */
import assert from 'node:assert/strict';

const m = await import('../lib/gateway-state.ts');
const { gatewayState, NOT_READY_AFTER_MS, blocksOpen, nextStartAnchor, skipGatewayTick, GATEWAY_POLL_STUCK_MS } = m;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

const NOW = 1_000_000_000_000;
const base = { running: true, startedAtMs: NOW - 5_000, probe: 'starting', nowMs: NOW };

test('the budget is ten minutes', () => {
  assert.equal(NOT_READY_AFTER_MS, 600_000);
});

test('a stopped container is stopped whatever the probe says', () => {
  assert.equal(gatewayState({ ...base, running: false, probe: 'ready' }), 'stopped');
  assert.equal(gatewayState({ ...base, running: false, probe: null }), 'stopped');
});

test('a ready probe is ready, even long after the start', () => {
  assert.equal(gatewayState({ ...base, probe: 'ready' }), 'ready');
  assert.equal(gatewayState({ ...base, probe: 'ready', startedAtMs: NOW - 3_600_000 }), 'ready');
});

test('starting inside the budget is starting', () => {
  assert.equal(gatewayState({ ...base, startedAtMs: NOW - (NOT_READY_AFTER_MS - 1) }), 'starting');
});

test('exactly at the boundary and after it is not_ready', () => {
  assert.equal(gatewayState({ ...base, startedAtMs: NOW - NOT_READY_AFTER_MS }), 'not_ready');
  assert.equal(gatewayState({ ...base, startedAtMs: NOW - NOT_READY_AFTER_MS - 1 }), 'not_ready');
});

test('no_answer is treated like starting', () => {
  assert.equal(gatewayState({ ...base, probe: 'no_answer' }), 'starting');
  assert.equal(gatewayState({ ...base, probe: 'no_answer', startedAtMs: NOW - NOT_READY_AFTER_MS }), 'not_ready');
});

test('an error probe is unknown', () => {
  assert.equal(gatewayState({ ...base, probe: 'error' }), 'unknown');
});

test('a missing probe is unknown', () => {
  assert.equal(gatewayState({ ...base, probe: null }), 'unknown');
  assert.equal(gatewayState({ ...base, probe: undefined }), 'unknown');
});

test('a missing or invalid start time is starting, never not_ready', () => {
  for (const startedAtMs of [null, undefined, NaN, 0, Infinity]) {
    assert.equal(gatewayState({ ...base, startedAtMs }), 'starting');
  }
});

test('a start time in the future (clock skew) is starting', () => {
  assert.equal(gatewayState({ ...base, startedAtMs: NOW + 60_000 }), 'starting');
});

test('notReadyAfterMs can be overridden', () => {
  assert.equal(gatewayState({ ...base, startedAtMs: NOW - 2_000, notReadyAfterMs: 1_000 }), 'not_ready');
});

test('an unexpected answer is unknown, whatever the age', () => {
  assert.equal(gatewayState({ ...base, probe: 'unexpected' }), 'unknown');
  assert.equal(gatewayState({ ...base, probe: 'unexpected', startedAtMs: NOW - NOT_READY_AFTER_MS - 1 }), 'unknown');
});

test('blocksOpen is true only for a 503 inside the budget', () => {
  assert.equal(blocksOpen('starting', 'starting'), true);
  for (const [probe, state] of [
    ['no_answer', 'starting'], ['unexpected', 'unknown'], ['error', 'unknown'], [null, 'unknown'], [undefined, 'unknown'],
    ['ready', 'ready'], ['starting', 'not_ready'], ['no_answer', 'not_ready'], ['starting', 'stopped'], ['starting', 'unknown'],
  ]) {
    assert.equal(blocksOpen(probe, state), false, `${probe} / ${state}`);
  }
});

test('blocksOpen follows gatewayState end to end', () => {
  const st = (probe, startedAtMs) => gatewayState({ ...base, probe, startedAtMs });
  assert.equal(blocksOpen('starting', st('starting', NOW - 1_000)), true);
  assert.equal(blocksOpen('starting', st('starting', NOW - NOT_READY_AFTER_MS)), false);
  assert.equal(blocksOpen('no_answer', st('no_answer', NOW - 1_000)), false);
});

test('anchor: ready clears it', () => {
  assert.equal(nextStartAnchor({ anchorMs: 5, restartCount: 2 }, { startedAtMs: 9, restartCount: 2, ready: true }), null);
  assert.equal(nextStartAnchor(null, { startedAtMs: 9, restartCount: 0, ready: true }), null);
});

test('anchor: the first observation anchors at the start time', () => {
  assert.deepEqual(nextStartAnchor(null, { startedAtMs: 100, restartCount: 0, ready: false }), { anchorMs: 100, restartCount: 0 });
  assert.deepEqual(nextStartAnchor(undefined, { startedAtMs: 100, restartCount: 3, ready: false }), { anchorMs: 100, restartCount: 3 });
  assert.equal(nextStartAnchor(null, { startedAtMs: null, restartCount: 0, ready: false }), null);
  assert.equal(nextStartAnchor(null, { startedAtMs: NaN, restartCount: 0, ready: false }), null);
});

test('anchor: a policy restart (count grows) keeps the anchor', () => {
  assert.deepEqual(
    nextStartAnchor({ anchorMs: 100, restartCount: 3 }, { startedAtMs: 500, restartCount: 4, ready: false }),
    { anchorMs: 100, restartCount: 4 },
  );
});

test('anchor: a manual restart (count shrinks or is 0 with a new start) moves the anchor', () => {
  assert.deepEqual(
    nextStartAnchor({ anchorMs: 100, restartCount: 4 }, { startedAtMs: 900, restartCount: 0, ready: false }),
    { anchorMs: 900, restartCount: 0 },
  );
  assert.deepEqual(
    nextStartAnchor({ anchorMs: 100, restartCount: 4 }, { startedAtMs: 900, restartCount: 1, ready: false }),
    { anchorMs: 900, restartCount: 1 },
  );
  assert.deepEqual(
    nextStartAnchor({ anchorMs: 100, restartCount: 0 }, { startedAtMs: 900, restartCount: 0, ready: false }),
    { anchorMs: 900, restartCount: 0 },
  );
});

test('anchor: same count and same start keeps it', () => {
  assert.deepEqual(
    nextStartAnchor({ anchorMs: 100, restartCount: 0 }, { startedAtMs: 100, restartCount: 0, ready: false }),
    { anchorMs: 100, restartCount: 0 },
  );
  assert.deepEqual(
    nextStartAnchor({ anchorMs: 100, restartCount: 4 }, { startedAtMs: 500, restartCount: 4, ready: false }),
    { anchorMs: 100, restartCount: 4 },
  );
});

test('anchor: a missing start time keeps the previous anchor', () => {
  assert.deepEqual(
    nextStartAnchor({ anchorMs: 100, restartCount: 2 }, { startedAtMs: null, restartCount: 0, ready: false }),
    { anchorMs: 100, restartCount: 0 },
  );
});

test('a crash loop reaches not_ready through the anchor', () => {
  let anchor = null;
  const t0 = NOW - NOT_READY_AFTER_MS - 1_000; // first seen long ago
  anchor = nextStartAnchor(anchor, { startedAtMs: t0, restartCount: 0, ready: false });
  // Docker has since restarted it many times: StartedAt is recent, the count grew.
  anchor = nextStartAnchor(anchor, { startedAtMs: NOW - 1_000, restartCount: 40, ready: false });
  assert.equal(gatewayState({ ...base, probe: 'no_answer', startedAtMs: anchor.anchorMs }), 'not_ready');
});

test('budget boundary on the anchor', () => {
  const anchorOf = (anchorMs) => gatewayState({ ...base, probe: 'starting', startedAtMs: anchorMs });
  assert.equal(anchorOf(NOW - NOT_READY_AFTER_MS + 1), 'starting');
  assert.equal(anchorOf(NOW - NOT_READY_AFTER_MS), 'not_ready');
});

test('poll guard: ticks skip while a fresh request is in flight, never when none or stuck', () => {
  assert.equal(skipGatewayTick(null, NOW), false);
  assert.equal(skipGatewayTick(undefined, NOW), false);
  assert.equal(skipGatewayTick(NOW - 5_000, NOW), true);
  assert.equal(skipGatewayTick(NOW - GATEWAY_POLL_STUCK_MS + 1, NOW), true);
  assert.equal(skipGatewayTick(NOW - GATEWAY_POLL_STUCK_MS, NOW), false);
});

console.log(`${passed} passed`);
