#!/usr/bin/env node
/** Pure capacity boundaries and actual Create/Update admission paths with Docker fully mocked. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const policy = require('../lib/agent-resource-policy.js');
const memory = require('../lib/agent-memory-limit.js');
const stats = require('../lib/docker-stats.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1024 * 1024;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error.stack}`); process.exit(1); }
}
const create = (over = {}) => ({ version: '2026.10.10', operation: 'create', targetAgentId: 'new', limitMb: 4096,
  dockerTotalMb: 10000, containers: [], ...over });

await test('candidate finite-limit boundaries use the evaluated floor only', () => {
  for (const limitMb of [2047, 2048, 3072, 4095]) assert.equal(policy.evaluateAgentResources(create({ limitMb })).ok, false, String(limitMb));
  assert.equal(policy.evaluateAgentResources(create()).ok, true);
  for (const version of ['2026.9.3', '2026.9.9']) {
    assert.equal(policy.resourcePolicyFor(version).reserveMb, 2048);
    assert.equal(policy.memoryLimitPolicyError(version, 2047), '');
    assert.equal(policy.evaluateAgentResources(create({ version, limitMb: 256 })).ok, true);
  }
});
await test('no limit remains no limit and reserves planning headroom only', () => {
  const input = create({ limitMb: null });
  const before = structuredClone(input);
  const result = policy.evaluateAgentResources(input);
  assert.equal(result.ok, true);
  assert.equal(result.targetReserveMb, 4096);
  assert.deepEqual(input, before);
  assert.deepEqual(memory.rebuildLimitArgs({ Memory: 0, MemorySwap: 0 }), []);
});
await test('unknown version/capacity is explicit and cannot authorize mutation', () => {
  for (const version of [null, undefined, '2026.10.11', '2026.10.10-1']) {
    assert.equal(policy.evaluateAgentResources(create({ version })).code, 'unknown-version');
  }
  for (const dockerTotalMb of [null, undefined, 0, NaN, Infinity]) {
    assert.equal(policy.evaluateAgentResources(create({ dockerTotalMb })).code, 'unknown-host');
  }
});
await test('exact host boundary includes 1 GiB host headroom', () => {
  assert.equal(policy.evaluateAgentResources(create({ dockerTotalMb: 5119 })).code, 'insufficient-host');
  assert.equal(policy.evaluateAgentResources(create({ dockerTotalMb: 5120 })).ok, true);
});
await test('other finite agents count by cap, unlimited agents by working set plus headroom', () => {
  const result = policy.evaluateAgentResources(create({ containers: [
    { agentId: 'finite', limitMb: 2048, usageMb: null }, { agentId: 'unlimited', limitMb: null, usageMb: 512 },
  ] }));
  assert.equal(result.ok, true);
  assert.equal(result.otherReserveMb, 3584);
  assert.equal(result.requiredMb, 8704);
  assert.equal(policy.evaluateAgentResources(create({ containers: [{ agentId: 'unlimited', limitMb: null, usageMb: null }] })).code, 'unknown-usage');
});
await test('non-agent load is included; unreadable unlimited load is never treated as zero', () => {
  const result = policy.evaluateAgentResources(create({ containers: [{ agentId: null, limitMb: null, usageMb: 512 }] }));
  assert.equal(result.otherReserveMb, 512);
  assert.equal(policy.evaluateAgentResources(create({ containers: [{ agentId: null, limitMb: null, usageMb: null }] })).code, 'unknown-usage');
});
await test('updating target counts once, and unlimited current usage must be known', () => {
  const result = policy.evaluateAgentResources(create({ operation: 'update', targetAgentId: 'ours', limitMb: null,
    targetUsageMb: 4096, dockerTotalMb: 8000, containers: [{ agentId: 'ours', limitMb: null, usageMb: 4096 }] }));
  assert.equal(result.targetReserveMb, 5120);
  assert.equal(result.otherReserveMb, 0);
  assert.equal(policy.evaluateAgentResources(create({ operation: 'update', limitMb: null })).code, 'unknown-usage');
});
await test('reservations deduplicate visible agents and prefer a larger prospective allocation', () => {
  const result = policy.evaluateAgentResources(create({ containers: [{ agentId: 'other', limitMb: 2048, usageMb: null }],
    reservations: [{ agentId: 'other', reservedMb: 3072 }, { agentId: 'future', reservedMb: 512 }] }));
  assert.equal(result.otherReserveMb, 3584);
});

// Transpile the real server modules into isolated contexts. Only declared mock dependencies exist.
function load(file, mocks, extra = {}) {
  const full = path.join(root, file);
  const source = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const context = { exports: {}, require: (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    throw new Error(`Unmocked dependency: ${id}`);
  }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, process: { env: {}, cwd: () => root }, Buffer, ...extra };
  vm.runInNewContext(source, context, { filename: full });
  return context.exports;
}
function preflight() {
  return load('lib/agent-resource-preflight.ts', {
    '@/lib/docker-socket-path': { dockerRequestJson: () => { throw new Error('Real Docker is forbidden in this test'); } },
    '@/lib/docker-stats': stats, '@/lib/agent-resource-policy': policy,
  });
}
const pre = preflight();
const facts = (over = {}) => async () => ({ dockerTotalMb: 7834, containers: [], ...over });

await test('actual bounded collector reads current Docker facts without CLI processes', async () => {
  const calls = [];
  const id = 'a'.repeat(64);
  const result = await pre.readDockerResourceFacts(async (apiPath, timeoutMs) => {
    calls.push(apiPath); assert.ok(timeoutMs > 0 && timeoutMs <= 5000);
    if (apiPath === '/info') return { MemTotal: 7834 * MB };
    if (apiPath === '/containers/json') return [{ Id: id }];
    if (apiPath.endsWith('/json')) return { State: { Running: true }, HostConfig: { Memory: 0 }, Config: { Labels: { AGENT_ID: 'other' } } };
    return { memory_stats: { usage: 600 * MB, stats: { inactive_file: 100 * MB } } };
  });
  assert.equal(result.dockerTotalMb, 7834);
  assert.equal(result.containers[0].usageMb, 500);
  assert.equal(calls.length, 4);
});
await test('bounded collector rejects unreadable capacity, excessive lists and changing containers', async () => {
  await assert.rejects(pre.readDockerResourceFacts(async () => ({})), /incomplete/);
  await assert.rejects(pre.readDockerResourceFacts(async (apiPath) => apiPath === '/info' ? { MemTotal: 7834 * MB } : Array(129).fill({})), /incomplete/);
  await assert.rejects(pre.readDockerResourceFacts(async (apiPath) => {
    if (apiPath === '/info') return { MemTotal: 7834 * MB };
    if (apiPath === '/containers/json') return [{ Id: 'a'.repeat(64) }];
    return { State: { Running: false } };
  }), /changed/);
});
await test('simultaneous creates cannot spend the same snapshot twice', async () => {
  const admissions = await Promise.allSettled([
    pre.acquireAgentResourcePreflight({ ...create(), targetAgentId: 'race-a' }, facts({ dockerTotalMb: 6000 })),
    pre.acquireAgentResourcePreflight({ ...create(), targetAgentId: 'race-b' }, facts({ dockerTotalMb: 6000 })),
  ]);
  assert.equal(admissions.filter((r) => r.status === 'fulfilled').length, 1);
  const accepted = admissions.find((r) => r.status === 'fulfilled');
  accepted.value();
  const retry = await pre.acquireAgentResourcePreflight({ ...create(), targetAgentId: 'race-b' }, facts({ dockerTotalMb: 6000 }));
  retry();
});
await test('duplicate claim refuses; release is idempotent and cannot clear a later owner', async () => {
  const input = { ...create(), targetAgentId: 'duplicate' };
  const release = await pre.acquireAgentResourcePreflight(input, facts());
  await assert.rejects(pre.acquireAgentResourcePreflight(input, facts()), /already reserves/);
  release();
  const later = await pre.acquireAgentResourcePreflight(input, facts());
  release();
  await assert.rejects(pre.acquireAgentResourcePreflight(input, facts()), /already reserves/);
  later();
});
await test('failed capacity read/admission leaves no reservation and does not modify limits', async () => {
  const input = { ...create(), targetAgentId: 'failed' };
  await assert.rejects(pre.acquireAgentResourcePreflight(input, async () => { throw new Error('Docker down'); }), /could not be read/);
  await assert.rejects(pre.acquireAgentResourcePreflight(input, facts({ dockerTotalMb: 4096 })), /Docker has/);
  const release = await pre.acquireAgentResourcePreflight(input, facts());
  release();
  assert.equal(input.limitMb, 4096);
});
await test('actual update admission detects a changed target limit instead of guessing', async () => {
  await assert.rejects(pre.acquireAgentResourcePreflight({ ...create(), operation: 'update', targetAgentId: 'changed' }, facts({
    containers: [{ agentId: 'changed', limitMb: 5120, usageMb: null }],
  })), /changed/);
});

function createRoute(admit) {
  const calls = [];
  const next = { NextResponse: { json: (body, options = {}) => ({ status: options.status ?? 200, body }) } };
  const mocks = {
    'next/server': next,
    'child_process': { execSync: (cmd) => { calls.push(cmd); return ''; }, execFileSync: () => { throw new Error('Unexpected Docker mutation'); } },
    crypto: { randomBytes: () => Buffer.from('00000001', 'hex') }, fs, path,
    '../../gateway/sync': {}, '../../gateway/provider/keys': { readProviderKeys: () => ({}) },
    '@/lib/agent-config-lock': {},
    '@/lib/agent-model-setup': load('lib/agent-model-setup.ts', {}),
    '@/app/api/provider/upstream': { extractProviderAndModel: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) },
    '@/lib/rev4a-paths': { AGENTS_TOKEN_FILE: path.join(root, 'does-not-exist-resource-test'), templatesDir: () => path.join(root, 'agent-templates') },
    '@/lib/agent-setup': { getMountFlags: () => [] },
    '@/lib/agent-images': { listLocalAgentImages: async () => [], newestLocalSupportedVersion: () => '2026.10.10', runDocker: () => { calls.push('MUTATION docker run'); } },
    '@/lib/agent-versions': { localImageRef: (v) => `test:${v}` }, '@/lib/model-catalogue': { isModelOffered: () => true },
    '@/lib/agent-ports': { findAvailablePortBlock: () => 4500, DEFAULT_BLOCK_SIZE: 10 }, '@/lib/agent-ports-server': { getUsedHostPorts: async () => new Set() },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => null }, '@/lib/agent-readiness': {},
    '@/lib/redact-secret': { redactSecret: (text) => text }, '@/lib/agent-token-lock': { acquireTokenLock: async () => () => {} },
    '@/lib/agent-create-args': {}, '@/lib/agent-memory-limit': memory, '@/lib/agent-volumes': {}, '@/lib/agent-volumes-server': {},
    '@/lib/agent-resource-preflight': { ...pre, acquireAgentResourcePreflight: admit },
  };
  return { route: load('app/api/agents/create/route.ts', mocks), calls };
}
await test('actual Create refuses the old cap through direct API before any create/network/volume mutation', async () => {
  const { route, calls } = createRoute((input) => pre.acquireAgentResourcePreflight(input, facts()));
  for (const memoryLimitMb of [2048, 3072]) {
    const result = await route.POST({ json: async () => ({ name: 'oc-eval-test', template: 'custom', memoryLimitMb }) });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /at least 4 GB/);
  }
  assert.ok(!calls.some((cmd) => /MUTATION|network|volume|docker run/.test(cmd)));
});
await test('actual Create refuses unknown/insufficient host facts before mutation', async () => {
  for (const dockerTotalMb of [null, 4095]) {
    const { route, calls } = createRoute((input) => pre.acquireAgentResourcePreflight(input, facts({ dockerTotalMb })));
    const result = await route.POST({ json: async () => ({ name: 'oc-eval-test', template: 'custom', memoryLimitMb: 4096 }) });
    assert.equal(result.status, 409);
    assert.ok(!calls.some((cmd) => /MUTATION|network|volume|docker run/.test(cmd)));
  }
});
await test('actual Create releases admitted resources on an early post-preflight error', async () => {
  const { route } = createRoute((input) => pre.acquireAgentResourcePreflight(input, facts()));
  const result = await route.POST({ json: async () => ({ name: 'oc-eval-test', template: 'custom', memoryLimitMb: null }) });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /gateway token is missing/);
  const release = await pre.acquireAgentResourcePreflight({ ...create(), targetAgentId: 'agent_00000001', limitMb: null }, facts());
  release();
});

function updateModule(limitMb, dockerTotalMb, throwAfterAdmission = false) {
  const calls = [];
  const container = { Name: '/agent_test', Image: 'image', State: { Running: true }, HostConfig: { Memory: limitMb === null ? 0 : limitMb * MB } };
  const reader = facts({ dockerTotalMb, containers: [{ agentId: 'agent_test', limitMb, usageMb: limitMb === null ? 1536 : null }] });
  const mocks = new Proxy({
    '@/lib/docker-exec': { dockerExec: () => { calls.push('count'); throw new Error('Unexpected count'); }, dockerExecNoFail: () => { calls.push('cron'); throw new Error('Unexpected cron'); } },
    '@/lib/container': { isValidAgentId: () => true }, '@/lib/gateway-cli': { gatewayCliArgv: (args) => args },
    '@/lib/agent-versions': { isSupportedVersion: () => true, compareVersions: () => 1 },
    '@/lib/agent-images': { listLocalAgentImages: async () => [], containerOpenClawVersion: async () => '2026.9.9', newestLocalSupportedVersion: () => '2026.10.10', localVersionExists: async () => true },
    '@/lib/agent-recreate': { inspectAgentContainer: async () => container },
    '@/lib/agent-busy': { agentBusyReason: async () => null },
    // The background job waits for the Gateway before reading the cron list.
    '@/lib/agent-readiness': { waitForGatewayReady: async () => true, probeGateway: async () => 'ready' },
    '@/lib/agent-update-state': {
      insertUpdate: () => { calls.push('insert'); if (throwAfterAdmission) throw new Error('admitted sentinel'); return 1; },
      updateRow: (_id, fields) => { calls.push(fields.status); },
    },
    '@/lib/agent-resource-preflight': { acquireAgentResourcePreflight: (input) => pre.acquireAgentResourcePreflight(input, reader) },
    '@/lib/redact-secret': { redactSecret: (text) => text },
    'node:fs': fs,
  }, { get: (target, id) => Object.hasOwn(target, id) ? target[id] : {} });
  return { module: load('lib/agent-update.ts', new Proxy(mocks, { getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }) })), calls, container, reader };
}
await test('actual Update rejects 2 and 3 GiB before inserting a job, counting, backup or stop', async () => {
  for (const limitMb of [2048, 3072]) {
    const { module, calls, container } = updateModule(limitMb, 7834);
    await assert.rejects(module.startAgentUpdate('agent_test'), /at least 4 GB/);
    assert.deepEqual(calls, []);
    assert.equal(container.HostConfig.Memory, limitMb * MB);
  }
});
await test('actual Update rejects unknown/insufficient capacity before lifecycle mutation', async () => {
  for (const host of [null, 4095]) {
    const { module, calls } = updateModule(4096, host);
    await assert.rejects(module.startAgentUpdate('agent_test'), /Docker|capacity/);
    assert.deepEqual(calls, []);
  }
});
await test('actual Update preserves unlimited and releases a claim if inserting the job fails', async () => {
  const { module, calls, container, reader } = updateModule(null, 7834, true);
  await assert.rejects(module.startAgentUpdate('agent_test'), /admitted sentinel/);
  assert.deepEqual(calls, ['insert']);
  assert.equal(container.HostConfig.Memory, 0);
  const release = await pre.acquireAgentResourcePreflight({ ...create(), operation: 'update', targetAgentId: 'agent_test', limitMb: null }, reader);
  release();
});
await test('actual Update releases its claim when the background update reaches failure', async () => {
  const { module, calls, reader } = updateModule(4096, 7834);
  assert.equal(await module.startAgentUpdate('agent_test'), 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['insert', 'cron', 'failed']);
  const release = await pre.acquireAgentResourcePreflight({ ...create(), operation: 'update', targetAgentId: 'agent_test' }, reader);
  release();
});

console.log(`\n${passed} passed`);
