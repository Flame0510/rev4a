#!/usr/bin/env node
/**
 * Tests for lib/gateway-state.ts (the Gateway state shown on the Agents page).
 *
 *   node scripts/test-gateway-state.mjs
 */
import assert from 'node:assert/strict';

const m = await import('../lib/gateway-state.ts');
const { gatewayState, NOT_READY_AFTER_MS } = m;

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

console.log(`${passed} passed`);
