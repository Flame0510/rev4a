#!/usr/bin/env node
/**
 * Tests for lib/agent-volumes.ts (volume names, orphan detection, create readiness window).
 *
 *   node scripts/test-agent-volumes.mjs
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

const m = await import('../lib/agent-volumes.ts');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

test('the volume name is agent-<container>-data', () => {
  assert.equal(m.agentVolumeName('agent_1a2b3c4d'), 'agent-agent_1a2b3c4d-data');
});

test('only agent-*-data names are valid', () => {
  assert.equal(m.isAgentVolumeName('agent-agent_1a2b3c4d-data'), true);
  assert.equal(m.isAgentVolumeName('agent-atlas-data'), true);
  for (const bad of ['rev4a-data', 'rev4a-skills', 'agent--data', 'agent-x', 'agent-a/b-data', 'agent-../x-data', 'agent-a b-data', 'agent-a;rm-data', '', 'xagent-a-data', 'agent-a-data\n', null, undefined, 42]) {
    assert.equal(m.isAgentVolumeName(bad), false, String(bad));
  }
});

test('orphans: agent volumes no container mounts, any state, newest first', () => {
  const volumes = [
    { Name: 'agent-agent_aaaaaaaa-data', CreatedAt: '2026-10-20T10:00:00Z', UsageData: { Size: 570 } },
    { Name: 'agent-agent_bbbbbbbb-data', CreatedAt: '2026-10-22T10:00:00Z', UsageData: { Size: -1 } },
    { Name: 'agent-agent_cccccccc-data', CreatedAt: '2026-10-21T10:00:00Z' },
    { Name: 'rev4a-shared', CreatedAt: '2026-10-01T10:00:00Z' },
    { Name: 'other-data', CreatedAt: '2026-10-01T10:00:00Z' },
  ];
  const containers = [
    { Mounts: [{ Type: 'volume', Name: 'agent-agent_cccccccc-data' }, { Type: 'bind' }] },
    { Mounts: null },
    {},
  ];
  const out = m.findOrphanVolumes(volumes, containers);
  assert.deepEqual(out.map((v) => v.name), ['agent-agent_bbbbbbbb-data', 'agent-agent_aaaaaaaa-data']);
  assert.equal(out[0].sizeBytes, null);
  assert.equal(out[1].sizeBytes, 570);
});

test('a bind mount with the same name does not make a volume used', () => {
  const out = m.findOrphanVolumes(
    [{ Name: 'agent-x-data' }],
    [{ Mounts: [{ Type: 'bind', Name: 'agent-x-data' }] }],
  );
  assert.equal(out.length, 1);
});

test('architectures: Docker and image spellings compare equal', () => {
  assert.equal(m.isEmulated('amd64', 'x86_64'), false);
  assert.equal(m.isEmulated('arm64', 'aarch64'), false);
  assert.equal(m.isEmulated('amd64', 'aarch64'), true);
  assert.equal(m.isEmulated('arm64', 'x86_64'), true);
});

test('readiness window: 300 s under emulation, 120 s native or unknown', () => {
  assert.equal(m.readyTimeoutMs('amd64', 'aarch64'), 300_000);
  assert.equal(m.readyTimeoutMs('arm64', 'aarch64'), 120_000);
  assert.equal(m.readyTimeoutMs(undefined, 'aarch64'), 120_000);
  assert.equal(m.readyTimeoutMs('amd64', null), 120_000);
});


test('agent id comes from the volume name', () => {
  assert.equal(m.agentIdFromVolumeName('agent-agent_1a2b3c4d-data'), 'agent_1a2b3c4d');
  assert.equal(m.agentIdFromVolumeName('agent-atlas-data'), 'atlas');
  assert.equal(m.agentIdFromVolumeName('rev4a-data'), null);
  assert.equal(m.agentIdFromVolumeName(undefined), null);
});

test('keep decision: busy hides, unfinished recreate/update keeps, finished is deletable', () => {
  const base = { busy: false, recreateStatus: null, updateStatus: null };
  assert.equal(m.volumeKeepDecision(base), null);
  assert.equal(m.volumeKeepDecision({ ...base, busy: true }), 'busy');
  assert.equal(m.volumeKeepDecision({ ...base, editStatus: 'failed' }), m.UNFINISHED_KEPT_REASON);
  assert.equal(m.volumeKeepDecision({ ...base, editStatus: 'interrupted' }), m.UNFINISHED_KEPT_REASON);
  assert.equal(m.volumeKeepDecision({ ...base, editStatus: 'done' }), null);
  assert.equal(m.volumeKeepDecision({ ...base, busy: true, recreateStatus: 'failed' }), 'busy');
  assert.equal(m.volumeKeepDecision({ ...base, recreateStatus: 'done' }), null);
  for (const s of ['failed', 'interrupted', 'recreating', 'backing_up']) {
    assert.equal(m.volumeKeepDecision({ ...base, recreateStatus: s }), m.UNFINISHED_KEPT_REASON, s);
  }
  assert.equal(m.volumeKeepDecision({ ...base, updateStatus: 'done' }), null);
  assert.equal(m.volumeKeepDecision({ ...base, updateStatus: 'rolled_back' }), null);
  assert.equal(m.volumeKeepDecision({ ...base, updateStatus: 'failed' }), m.UNFINISHED_KEPT_REASON);
  assert.equal(m.volumeKeepDecision({ ...base, updateStatus: 'rollback_failed' }), m.UNFINISHED_KEPT_REASON);
  assert.equal(m.volumeKeepDecision({ ...base, updateStatus: 'failed', updateResolved: true }), null);
});
