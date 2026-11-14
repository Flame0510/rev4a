#!/usr/bin/env node
/** Read-only account references: real projection, status conversion and row rendering; no transport. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const helpers = require('../lib/subscriptions-parse.js');
const { subscriptionProfileReferences, parseStatusJson, mapStoreProfile } = helpers;
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
const profile = (id, extra = {}) => ({
  id, type: 'oauth', provider: 'openai', email: 'fixture@example.invalid', plan: 'Plus',
  expiresAt: '2026-10-01T00:00:00.000Z', ...extra,
});
const profiles = [profile('openai:older'), profile('openai:newer', { expiresAt: '2026-12-01T00:00:00.000Z', plan: 'Pro' })];
const plain = value => JSON.parse(JSON.stringify(value));

await test('all OAuth references survive, including shared emails and older expiry; none is selected', () => {
  const result = subscriptionProfileReferences(profiles);
  assert.deepEqual(result.map(row => row.id), ['openai:older', 'openai:newer']);
  assert.deepEqual(result.map(row => row.email), ['fixture@example.invalid', 'fixture@example.invalid']);
  for (const row of result) assert.deepEqual(Object.keys(row).sort(), ['email', 'expiresAt', 'id', 'plan']);
  assert.equal(result[0].expiresAt, profiles[0].expiresAt);
});

await test('strict projection never reads or forwards access, refresh, account ID or grant fields', () => {
  let secretReads = 0;
  const raw = profile('openai:safe');
  for (const key of ['access', 'refresh', 'accountId', 'grant', 'authorization', 'token', 'unknown']) {
    Object.defineProperty(raw, key, { enumerable: true, get() { secretReads++; return 'private-sentinel'; } });
  }
  const result = subscriptionProfileReferences([raw]);
  assert.equal(secretReads, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-sentinel|accountId|grant|access|refresh/);
  assert.deepEqual(Object.keys(result[0]).sort(), ['email', 'expiresAt', 'id', 'plan']);
});

await test('API keys, other providers and malformed identities cannot become adoption references', () => {
  const invalid = [
    profile('openai:key', { type: 'api_key' }), profile('anthropic:oauth'),
    profile('openai:other-provider', { provider: 'anthropic' }), profile('openai:no-type', { type: null }),
    profile('openai:'), profile('openai:bad\nreference'), profile(3), null, [], {},
  ];
  assert.deepEqual(subscriptionProfileReferences(invalid), []);
});

await test('legacy optional metadata remains nullable without exposing arbitrary objects', () => {
  assert.deepEqual(subscriptionProfileReferences([{ id: 'openai:legacy', type: 'oauth' }]), [
    { id: 'openai:legacy', email: null, plan: null, expiresAt: null },
  ]);
  const result = subscriptionProfileReferences([profile('openai:malformed', {
    email: { private: 'sentinel' }, plan: { private: 'sentinel' }, expiresAt: 'not a date',
  })]);
  assert.deepEqual(result, [{ id: 'openai:malformed', email: null, plan: null, expiresAt: null }]);
});

await test('missing, unsupported and older status payloads gracefully supply no references', () => {
  for (const missing of [null, undefined, {}, 'not profiles']) assert.deepEqual(subscriptionProfileReferences(missing), []);
  for (const raw of ['{"legacy":true}', '{"unsupported":true}', '{"model":null}']) {
    assert.deepEqual(subscriptionProfileReferences(parseStatusJson(raw)?.profiles), []);
  }
});

await test('the actual in-container profile mapper and status parser retain only safe reference metadata', () => {
  const mapped = mapStoreProfile('openai:from-store', {
    type: 'oauth', provider: 'openai', email: 'fixture@example.invalid', expires: 1_800_000_000_000,
    chatgptPlanType: 'plus', access: 'private-access', refresh: 'private-refresh', accountId: 'private-account', grant: { secret: 'private-grant' }, // secret-ok: synthetic redaction fixture
  });
  const parsed = parseStatusJson(JSON.stringify({ profiles: [mapped] }));
  assert.deepEqual(subscriptionProfileReferences(parsed.profiles), [{
    id: 'openai:from-store', email: 'fixture@example.invalid', plan: 'Plus', expiresAt: new Date(1_800_000_000_000).toISOString(),
  }]);
  assert.doesNotMatch(JSON.stringify(parsed), /private-/);
});

function functions(file, names, dependencies, jsx = false) {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const declarations = names.map(name => parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name));
  assert.ok(declarations.every(Boolean));
  const code = ts.transpileModule(declarations.map(node => node.getText(parsed)).join('\n') + '\nmodule.exports = {' + names.join(',') + '};', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, ...dependencies });
  return module.exports;
}
const agent = { agentId: 'agent_fixture', container: 'fixture-container', running: true, displayName: 'Fixture agent' };
const statusHelpers = readAgentState => ({
  readAgentState, subscriptionProfileReferences, normalizeModel: helpers.normalizeModel,
  isSubscriptionModel: helpers.isSubscriptionModel, SubscriptionError: class extends Error {},
  statusReadFailedMessage: () => 'Status unavailable',
});
let status;
await test('actual per-agent status adds every safe reference while preserving existing summary/model fields', async () => {
  const { readAgent } = functions('lib/subscriptions.ts', ['emptyStatus', 'readAgent'], statusHelpers(async () => ({
    profiles, model: { primary: 'openai/fixture-model', fallbacks: ['rev4a/fixture-model'] },
  })));
  status = plain(await readAgent(agent));
  assert.deepEqual(status.profileReferences, subscriptionProfileReferences(profiles));
  assert.equal(status.email, 'fixture@example.invalid'); assert.equal(status.plan, 'Pro');
  assert.equal(status.primary, 'openai/fixture-model'); assert.equal(status.usesSubscription, true);
  assert.deepEqual(status.fallbacks, ['rev4a/fixture-model']);
});

await test('stopped or unreadable status returns an empty additive field without inventing a profile', async () => {
  let reads = 0;
  const { readAgent } = functions('lib/subscriptions.ts', ['emptyStatus', 'readAgent'], statusHelpers(async () => { reads++; throw new Error('private-native-detail'); }));
  assert.deepEqual(plain(await readAgent({ ...agent, running: false })).profileReferences, []);
  assert.equal(reads, 0);
  const unavailable = plain(await readAgent(agent));
  assert.deepEqual(unavailable.profileReferences, []); assert.equal(unavailable.error, 'Status unavailable');
});

await test('actual connected row renders all references in shared read-only inputs and tolerates older API absence', () => {
  const { AgentRow } = functions('app/subscriptions/PageClient.tsx', ['AgentRow'], {
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    Input: 'shared-input', Button: 'shared-button', Pill: 'pill', Skeleton: 'skeleton', Link: 'link',
    formatDate: value => value, modelName: value => value,
  }, true);
  const inputs = tree => {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap(inputs);
    return [...(tree.type === 'shared-input' ? [tree.props] : []), ...inputs(tree.children)];
  };
  const provider = { modelPrefix: 'openai/' };
  const copy = { accountLabel: 'ChatGPT account' };
  const row = value => AgentRow({ provider, copy, agent: { ...agent, name: 'Fixture agent' }, row: { status: value, job: null, loading: false }, onConnect() {}, onRetry() {}, onDisconnect() {} });
  const rendered = inputs(row(status));
  assert.deepEqual(rendered.map(input => input.value), profiles.map(profile => profile.id));
  for (const input of rendered) { assert.equal(input.readOnly, true); assert.equal(input.onChange, undefined); }
  const legacy = { ...status }; delete legacy.profileReferences;
  assert.deepEqual(inputs(row(legacy)), []);
});

console.log(`\n${passed} passed (read-only account references; no authentication or transport)`);

function rowReader() {
  const file = 'app/subscriptions/PageClient.tsx';
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.left.getText(parsed) === 'api.current.loadRow') callback = node.right;
    ts.forEachChild(node, visit);
  }
  visit(parsed); assert.ok(callback, 'Actual row loader not found');
  const pending = []; const patches = []; const polls = [];
  const rowAbort = { current: new Map() }; const alive = { current: true };
  const api = { current: { pollJob: (_providerId, agentId) => polls.push(agentId) } };
  const module = { exports: {} };
  const code = ts.transpileModule('module.exports = ' + callback.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, { module, rowAbort, alive, api, AbortController, encodeURIComponent,
    rowKey: (providerId, agentId) => `${providerId}:${agentId}`,
    providerAnd: () => '',
    patchRow: (providerId, agentId, patch) => patches.push({ providerId, agentId, ...patch }),
    fetch: async (_url, options) => options,
    readJson: response => new Promise((resolve, reject) => pending.push({ resolve, reject, response })),
  });
  return { load: module.exports, pending, patches, polls, alive, rowAbort };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
await test('a superseded delayed status body cannot restore an old account or restart polling', async () => {
  const f = rowReader(); const first = f.load('openai', 'agent_fixture'); await settle();
  const second = f.load('openai', 'agent_fixture'); await settle();
  assert.equal(f.pending[0].response.signal.aborted, true);
  f.pending[1].resolve({ agent: { profileReferences: [{ id: 'openai:current' }] }, action: null }); await second;
  const before = f.patches.length;
  f.pending[0].resolve({ agent: { profileReferences: [{ id: 'openai:replaced' }] }, action: { state: 'running' } }); await first;
  assert.equal(f.patches.length, before); assert.deepEqual(f.polls, []);
  assert.equal(f.patches.at(-1).status.profileReferences[0].id, 'openai:current');
});
await test('a superseded body failure cannot replace a current status with an old error', async () => {
  const f = rowReader(); const first = f.load('openai', 'agent_fixture'); await settle();
  const second = f.load('openai', 'agent_fixture'); await settle();
  f.pending[1].resolve({ agent: { profileReferences: [] }, action: null }); await second;
  const before = f.patches.length; f.pending[0].reject(new Error('Old body failure')); await first;
  assert.equal(f.patches.length, before); assert.equal(f.patches.at(-1).error, null);
});
await test('an unmounted row loader does not publish references or start polling', async () => {
  const f = rowReader(); const request = f.load('openai', 'agent_fixture'); await settle();
  f.alive.current = false; const before = f.patches.length;
  f.pending[0].resolve({ agent: { profileReferences: [{ id: 'openai:old' }] }, action: { state: 'running' } }); await request;
  assert.equal(f.patches.length, before); assert.deepEqual(f.polls, []);
});
console.log(`\n${passed} total passed (safe references and actual row request ownership)`);
