#!/usr/bin/env node
/**
 * Tests for lib/cron-ids.ts: the cron job id rule and the container check done before any exec.
 *
 *   node scripts/test-cron-ids.mjs
 */
import assert from 'node:assert/strict';
import s from '../lib/agent-sessions.js';
import { CRON_JOB_ID_RE, isValidCronJobId, checkCronRequest } from '../lib/cron-ids.ts';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

await test('job ids: no leading dash, no spaces or slashes, 128 characters at most', () => {
  for (const ok of ['abc', 'c1b3e47f-aaaa-bbbb', '_x', 'a'.repeat(128)]) assert.equal(isValidCronJobId(ok), true, ok);
  for (const bad of ['', '-rf', '--help', 'a b', 'a/b', 'a;b', 'a'.repeat(129), 'a\nb', 5, null, undefined]) assert.equal(isValidCronJobId(bad), false, String(bad));
});

await test('the TypeScript rule and the daemon rule are the same', () => {
  assert.equal(CRON_JOB_ID_RE.source, /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.source);
  for (const v of ['abc', '-x', 'a'.repeat(129), 'a b']) assert.equal(isValidCronJobId(v), s.validJobId(v));
});

const deps = (list, valid = (v) => typeof v === 'string' && /^[a-z0-9-]+$/.test(v)) => ({ isValidContainer: valid, listContainers: list });
const containers = async () => [{ container: 'openclaw-atlas' }];

await test('a bad job id is a 400 before the container is even looked up', async () => {
  let called = false;
  const r = await checkCronRequest({ jobId: '--help', containerName: 'openclaw-atlas' }, deps(async () => { called = true; return []; }));
  assert.deepEqual(r, { ok: false, status: 400, error: 'Invalid job id' });
  assert.equal(called, false);
});

await test('an unknown or malformed container is a 400 "Unknown agent"', async () => {
  assert.deepEqual(await checkCronRequest({ jobId: 'abc', containerName: 'other' }, deps(containers)), { ok: false, status: 400, error: 'Unknown agent' });
  assert.deepEqual(await checkCronRequest({ jobId: 'abc', containerName: 'x;rm' }, deps(containers)), { ok: false, status: 400, error: 'Unknown agent' });
  assert.deepEqual(await checkCronRequest({ jobId: 'abc', containerName: undefined }, deps(containers)), { ok: false, status: 400, error: 'Unknown agent' });
});

await test('a listed agent container passes; Docker down is a 502', async () => {
  assert.deepEqual(await checkCronRequest({ jobId: 'abc', containerName: 'openclaw-atlas' }, deps(containers)), { ok: true });
  const r = await checkCronRequest({ jobId: 'abc', containerName: 'openclaw-atlas' }, deps(async () => { throw new Error('down'); }));
  assert.deepEqual(r, { ok: false, status: 502, error: 'Docker is not reachable' });
});

console.log(`\n${passed} passed`);
