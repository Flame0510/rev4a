#!/usr/bin/env node
/** Exercise the subscriptions models route and account caches with in-memory Docker fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';
import subscriptionsParse from '../lib/subscriptions-parse.js';

function load(file, dependencies = {}, globals = {}) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, URL, setTimeout, clearTimeout, globalThis: globals,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency: ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}

const providers = load('lib/subscription-providers.ts');
const claudeParse = load('lib/subscription-claude-parse.ts');
const container = load('lib/container.ts', { child_process: {} });
const next = { NextResponse: { json: (body, options) => ({ status: options.status ?? 200, body: JSON.parse(JSON.stringify(body)) }) } };
const account = (email, key) => ({ email, models: key ? [{ key, name: key, available: true }] : [] });

function harness(provider, { otherReady = true, ownReady = true, email = true, connected = true, denied = null } = {}) {
  const ownKey = provider === 'openai' ? 'openai/local' : 'anthropic/claude-local';
  const otherKey = provider === 'openai' ? 'openai/gpt-6-astra' : 'anthropic/claude-sonnet-other';
  const own = account(email ? 'own@example.invalid' : null, ownReady ? ownKey : null);
  const other = account(email ? 'other@example.invalid' : null, otherReady ? otherKey : null);
  const accounts = { 'container-a': own, 'container-b': other };
  const modelReads = [];
  const statusReads = [];
  const dockerExec = async (name, args) => {
    const row = accounts[name];
    const loggedIn = name !== 'container-a' || connected;
    if (args[0] === 'node') {
      statusReads.push(name);
      if (args[2] === claudeParse.CLAUDE_STATUS_SCRIPT_SRC) {
        return JSON.stringify({
          installed: true,
          status: { loggedIn, authMethod: 'claude.ai', email: row.email },
          models: { 'anthropic/*': { agentRuntime: { id: 'claude-cli' } } },
        });
      }
      return JSON.stringify({
        profiles: loggedIn ? [{ id: 'openai:fixture', type: 'oauth', email: row.email }] : [],
      });
    }
    assert.deepEqual(Array.from(args), ['models', 'list', '--provider', provider, '--json']);
    modelReads.push(name);
    return JSON.stringify({ models: row.models });
  };
  const shared = {
    '@/lib/container': container,
    '@/lib/docker-exec': { dockerExec, mapWithConcurrency: (items, _limit, fn) => Promise.all(items.map(fn)) },
    '@/lib/agent-config-lock': {},
    '@/lib/gateway-cli': { gatewayCliArgv: (args) => args },
    '@/lib/credentials/native': {},
    '@/lib/subscriptions-parse': subscriptionsParse,
  };
  const globals = {};
  const subscriptions = load('lib/subscriptions.ts', {
    ...shared,
    child_process: { execFile: (_cmd, _args, _options, callback) => callback(null, { stdout: 'agent-a\tcontainer-a\trunning\nagent-b\tcontainer-b\trunning' }) },
    '@/lib/agent-names': { getAgentDisplayNames: async () => new Map() },
    '@/lib/agent-versions': { SUPPORTED_VERSIONS: [{ version: '2026.10.10' }] },
    '@/lib/agent-images': {},
    '@/lib/docker-socket-path': { dockerRequestJson: async () => null },
    '@/lib/subscription-providers': providers,
    util: { promisify },
  }, globals);
  const claude = load('lib/subscription-claude.ts', {
    ...shared,
    child_process: {},
    '@/lib/docker-socket': {},
    '@/lib/subscriptions': subscriptions,
    '@/lib/claude-lean-tools': {},
    '@/lib/claude-probe': {},
    '@/lib/claude-sandbox-env': {},
    '@/lib/subscription-claude-parse': claudeParse,
  }, globals);
  const route = load('app/api/subscriptions/models/route.ts', {
    'next/server': next,
    '@/lib/container': container,
    '@/lib/rev4a-auth': { requireAuthJWT: async () => denied },
    '@/lib/subscriptions': subscriptions,
    '@/lib/subscription-providers': providers,
    '@/lib/subscription-claude': claude,
  });
  return {
    get: (params = '') => route.GET({ url: `http://localhost/api/subscriptions/models?provider=${provider}${params}` }),
    own, ownKey, otherKey, modelReads, statusReads,
  };
}

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`ok   ${name}`);
}
const keys = (result) => result.body.models.map(({ key }) => key);

for (const provider of ['openai', 'anthropic']) {
  await test(`${provider}: a scoped read returns the target's own list even when another account is cached`, async () => {
    const h = harness(provider);
    assert.deepEqual(keys(await h.get()), [h.ownKey, h.otherKey]);
    h.statusReads.length = 0;
    const scoped = await h.get('&agentId=agent-a');
    assert.equal(scoped.status, 200);
    assert.deepEqual(keys(scoped), [h.ownKey]);
    assert.equal(scoped.body.pending, false);
    assert.deepEqual(h.statusReads, ['container-a']);
    assert.deepEqual(h.modelReads, ['container-a', 'container-b'], 'scoped read reuses the same account cache');
    console.log('     ' + JSON.stringify(scoped));
  });

  await test(`${provider}: another account's pending catalogue does not delay the target`, async () => {
    const h = harness(provider, { otherReady: false });
    assert.equal((await h.get()).body.pending, true);
    const scoped = await h.get('&agentId=agent-a');
    assert.deepEqual(keys(scoped), [h.ownKey]);
    assert.equal(scoped.body.pending, false);
    assert.deepEqual(h.modelReads, ['container-a', 'container-b']);
    console.log('     ' + JSON.stringify({ fleetPending: true, agentPending: scoped.body.pending }));
  });

  await test(`${provider}: the target's pending result is retried and never filled by another account`, async () => {
    const h = harness(provider, { ownReady: false });
    assert.deepEqual((await h.get('&agentId=agent-a')).body, { models: [], error: null, pending: true });
    h.own.models.push({ key: h.ownKey, available: true });
    assert.deepEqual(keys(await h.get('&agentId=agent-a')), [h.ownKey]);
    assert.deepEqual(h.modelReads, ['container-a', 'container-a']);
  });

  await test(`${provider}: profiles with no email cannot share the scoped catalogue`, async () => {
    const h = harness(provider, { email: false });
    assert.deepEqual(keys(await h.get('&agentId=agent-b')), [h.otherKey]);
    assert.deepEqual(keys(await h.get('&agentId=agent-a')), [h.ownKey]);
    assert.deepEqual(h.modelReads, ['container-b', 'container-a']);
  });

  await test(`${provider}: a disconnected agent returns the connection error without reading models`, async () => {
    const h = harness(provider, { connected: false });
    const result = await h.get('&agentId=agent-a');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { models: [], error: 'This agent is not connected.', pending: false });
    assert.deepEqual(h.modelReads, []);
    console.log('     ' + JSON.stringify(result));
  });
}

await test('invalid agent ids return 400 before reading an account', async () => {
  const h = harness('openai');
  for (const id of ['', '../other', 'a'.repeat(65)]) {
    const result = await h.get(`&agentId=${encodeURIComponent(id)}`);
    assert.deepEqual(result, { status: 400, body: { error: 'Invalid agent id' } });
  }
  assert.deepEqual(h.statusReads, []);
  console.log('     400 {"error":"Invalid agent id"}');
});

await test('the route returns the auth denial before reading an account', async () => {
  const denied = { status: 401 };
  const h = harness('openai', { denied });
  assert.equal(await h.get('&agentId=agent-a'), denied);
  assert.deepEqual(h.statusReads, []);
});

console.log(`\n${passed} passed`);
