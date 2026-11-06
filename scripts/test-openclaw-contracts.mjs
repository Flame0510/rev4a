#!/usr/bin/env node
/**
 * Replay sanitized, recorded OpenClaw release payloads through production parsers.
 * Transport is blocked: this suite needs neither Docker nor a signed-in provider.
 * These are parser contracts, not proof of live execution, migration or delivery.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import sessions from '../lib/agent-sessions.js';
import subscriptions from '../lib/subscriptions-parse.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'scripts', 'fixtures', 'openclaw-contracts');
const plain = value => JSON.parse(JSON.stringify(value));
const forbidden = () => { throw new Error('External transport is forbidden in the offline contract suite'); };
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error?.stack || error}`); process.exit(1); }
}

// Evaluate the real TS modules with an explicit import allowlist. Only private
// parser entry points are exposed; no parser implementation is copied here.
const modules = new Map();
function load(relative, expose = '') {
  if (modules.has(relative)) return modules.get(relative);
  const filename = path.join(root, relative);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8') + '\n' + expose, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const customRequire = name => {
    if (name === 'child_process') return { execSync: forbidden, execFileSync: forbidden, execFile: forbidden };
    if (name === 'util') return require('node:util');
    if (name === '@/lib/docker-exec') return {
      dockerExec: forbidden, dockerExecNoFail: forbidden, dockerExecShellNoFail: forbidden,
      buildExecArgs: forbidden, clientTimeoutMs: forbidden, isWrapperMissing: forbidden,
      unwrappedContainers: forbidden, mapWithConcurrency: forbidden,
    };
    if (name === '@/lib/docker-socket') return { dockerFetch: forbidden };
    if (name === '@/lib/container') return { isValidAgentId: forbidden };
    if (name === '@/lib/agent-config-lock') return { withAgentConfigLock: forbidden };
    if (name === '@/lib/agent-names') return { CONTAINER_NAME_RE: /^[A-Za-z0-9_-]+$/, describeAgent: value => value };
    if (name === '@/lib/gateway-cli') return load('lib/gateway-cli.ts');
    if (name === '@/lib/cron-ids') return load('lib/cron-ids.ts');
    if (name === '@/lib/channel-pairing-store') return require('../lib/channel-pairing-store.js');
    throw new Error(`Unexpected import in offline parser contract: ${name}`);
  };
  const evaluate = new vm.Script(`(function(exports, require, module) {\n${source}\n})`, { filename })
    .runInNewContext({ console, Buffer });
  evaluate(module.exports, customRequire, module);
  modules.set(relative, module.exports);
  return module.exports;
}
const channels = load('lib/channelManager.ts');
const cron = load('lib/openclaw-cron.ts', `
export const contract = { parseCronListOutput, extractScheduleExpr,
  setTransport: (fn: typeof dockerExecSync) => { dockerExecSync = fn; } };
`);
const devices = load('lib/agent-devices.ts', 'export const contract = { toPending, toApproved };');
const context = { container: 'fixture-container', agentName: 'Fixture agent' };

for (const version of ['2026.9.3', '2026.9.9', '2026.10.10']) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, `${version}.json`), 'utf8'));
  assert.equal(fixture.version, version);

  await test(`${version}: Telegram config uses shared parser and masks the placeholder`, () => {
    assert.deepEqual(plain(channels.parseTelegramChannel(fixture.telegram)), {
      connected: true, botToken: 'fixt...oken', dmPolicy: 'pairing', allowFrom: [], // secret-ok: synthetic offline fixture
    });
  });
  await test(`${version}: recorded cron list preserves schedule and retirement identity`, () => {
    const jobs = cron.contract.parseCronListOutput(JSON.stringify(fixture.cronList));
    assert.ok(Array.isArray(jobs));
    const command = jobs.find(job => job.id === 'fixture-command');
    const model = jobs.find(job => job.id === 'fixture-model');
    assert.ok(command && model);
    assert.equal(cron.contract.extractScheduleExpr(command), '*/30 * * * *');
    assert.equal(cron.contract.extractScheduleExpr(model), '0 3 1 1 *');
    assert.equal(jobs.some(job => job.declarationKey === 'skill-collection-review:main'), version !== '2026.10.10');
  });
  await test(`${version}: actual cron-history parser preserves success identity and usage`, () => {
    cron.contract.setTransport(() => JSON.stringify(fixture.cronRuns));
    const result = cron.getCronRuns('fixture-container', 'fixture-model', 5);
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 1);
    assert.deepEqual(plain(result.entries[0]), fixture.cronRuns.entries[0]);
    assert.equal(result.entries[0].status, 'ok');
    assert.equal(result.entries[0].sessionId, 'fixture-session');
    assert.equal(result.entries[0].usage.total_tokens, 15);
  });
  await test(`${version}: session fields normalize without inventing lineage or cost`, async () => {
    const page = sessions.parseListPage(fixture.sessionsList);
    const result = await sessions.readAllSessions(async () => fixture.sessionsList, context);
    assert.equal(result.complete, true);
    assert.equal(result.rows.length, page.sessions.length);
    for (const raw of page.sessions) {
      const row = result.rows.find(entry => entry.session_key === raw.key);
      assert.ok(row);
      assert.equal(row.container, context.container);
      assert.equal(row.session_id, raw.sessionId ?? null);
      assert.equal(row.total_tokens, raw.totalTokens ?? null);
      assert.equal(row.cost_usd, raw.estimatedCostUsd ?? null);
      assert.equal(row.parent_key, raw.spawnedBy ?? raw.parentSessionKey ?? null);
    }
    assert.equal(result.rows.filter(row => row.parent_kind === 'spawn').length, version === '2026.9.3' ? 0 : 1);
    const cronRow = result.rows.find(row => row.kind === 'cron');
    assert.equal(cronRow.cron_job_id, 'fixture-model');
  });
  await test(`${version}: model catalog normalizes consumed fields`, () => {
    const models = subscriptions.parseModelList(JSON.stringify(fixture.modelList));
    assert.deepEqual(models, fixture.modelList.models);
    assert.equal(models.length, 2);
    assert.equal(models[0].contextWindow, version === '2026.9.3' ? null : 128000);
  });
  await test(`${version}: quota normalization uses only sanitized account and window fields`, () => {
    const result = subscriptions.parseUsageStatus(JSON.stringify(fixture.quota));
    assert.equal(result.accounts.length, 1);
    const account = result.accounts[0];
    assert.equal(account.email, 'fixture@example.invalid');
    assert.equal(account.plan, 'Plus');
    assert.deepEqual(account.windows, [{ label: 'Window', usedPercent: 25, resetAt: new Date(1_800_000_001_000).toISOString() }]);
  });
  await test(`${version}: approved browser conversion preserves roles, scopes and last use`, () => {
    assert.equal(fixture.devices.paired.length, 1);
    const raw = fixture.devices.paired[0];
    const row = devices.contract.toApproved(raw);
    assert.equal(row.deviceId, 'fixture-device-0');
    assert.deepEqual(plain(row.roles), ['operator']);
    assert.deepEqual(plain(row.scopes), ['operator.read']);
    assert.equal(row.approvedAtMs, raw.approvedAtMs);
    const use = raw.tokens.map(token => token.lastUsedAtMs).filter(value => typeof value === 'number');
    assert.equal(row.lastUsedAtMs, use.length ? Math.max(...use) : raw.lastSeenAtMs ?? raw.lastConnectedAtMs ?? null);
  });
  if (fixture.pendingDevicesAfterSync) {
    await test(`${version}: populated pending browser request maps its stable fields`, () => {
      assert.equal(fixture.pendingDevicesAfterSync.length, 1);
      const raw = fixture.pendingDevicesAfterSync[0];
      const row = devices.contract.toPending(raw);
      assert.equal(row.requestId, 'fixture-request-0');
      assert.equal(row.deviceId, 'fixture-device-0');
      assert.equal(row.requestedAtMs, raw.ts);
      assert.deepEqual(plain(row.scopes), ['operator.read']);
    });
  }
}

await test('cron list: valid empty arrays differ from malformed envelopes', () => {
  assert.deepEqual(plain(cron.contract.parseCronListOutput('{"jobs":[]}')), []);
  assert.deepEqual(plain(cron.contract.parseCronListOutput('[]')), []);
  for (const raw of ['not-json', '{}', '{"jobs":{}}', '{"different":[]}']) {
    assert.equal(cron.contract.parseCronListOutput(raw), null);
  }
});
await test('cron history: valid empty differs from malformed and truncated output', () => {
  cron.contract.setTransport(() => '{"entries":[]}');
  assert.deepEqual(plain(cron.getCronRuns('fixture-container', 'fixture-model')), { ok: true, entries: [] });
  for (const raw of ['', '{"entries":', '{"entries":{}}', '{"different":[]}']) {
    cron.contract.setTransport(() => raw);
    const result = cron.getCronRuns('fixture-container', 'fixture-model');
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
});
await test('session listing: empty needs explicit total zero; malformed answers cannot erase rows', async () => {
  const empty = await sessions.readAllSessions(async () => ({ sessions: [], totalCount: 0, hasMore: false }), context);
  assert.deepEqual(empty, { rows: [], complete: true });
  for (const raw of [null, {}, { sessions: {} }, { sessions: [] }, { sessions: [], hasMore: true }]) {
    await assert.rejects(() => sessions.readAllSessions(async () => raw, context));
  }
});
await test('model catalog: empty list differs from unreadable output', () => {
  assert.deepEqual(subscriptions.parseModelList('{"models":[]}'), []);
  for (const raw of ['not-json', '{}', '{"models":{}}']) assert.equal(subscriptions.parseModelList(raw), null);
});
await test('Telegram config: disabled, missing and non-string token do not appear connected', () => {
  for (const config of [{}, { channels: {} }, { channels: { telegram: { enabled: false, botToken: 'fixture-token' } } }, { channels: { telegram: { botToken: 1 } } }]) { // secret-ok: synthetic offline fixture
    assert.equal(channels.parseTelegramChannel(config), null);
  }
});
await test('browser converters reject rows without required identities', () => {
  assert.equal(devices.contract.toApproved({}), null);
  assert.equal(devices.contract.toPending({ deviceId: 'fixture-device-0' }), null);
  assert.equal(devices.contract.toPending({ requestId: 'fixture-request-0' }), null);
});

console.log(`\n${passed} passed (offline release parser contracts; no live transport)`);
