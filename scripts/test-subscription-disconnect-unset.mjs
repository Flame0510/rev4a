#!/usr/bin/env node
// Run both real disconnect flows against an in-memory agent configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const subscriptionsParse = require('../lib/subscriptions-parse.js');

function load(file, dependencies = {}, globals = {}) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, globalThis: globals, setTimeout, clearTimeout,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency: ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}

const agentId = 'atlas';
const container = 'agent-atlas';
const configPath = '/root/.openclaw/openclaw.json';
const gatewayCli = load('lib/gateway-cli.ts');
const providers = load('lib/subscription-providers.ts');
const providerCopy = load('app/subscriptions/providers.ts', { '@/lib/subscription-providers': providers });
const claudeParse = load('lib/subscription-claude-parse.ts');
const agentModelSetup = load('lib/agent-model-setup.ts');
const { needsModelSetup } = agentModelSetup;

function harness(provider, { defaults = {}, list = [], blockWrite, keepNull = false } = {}) {
  const isClaude = provider === 'anthropic';
  const config = {
    agents: {
      defaults: { workspace: '/workspace', ...structuredClone(defaults) },
      list: structuredClone(list),
    },
  };
  if (isClaude) config.agents.defaults.models = { 'anthropic/*': { agentRuntime: { id: 'claude-cli' } } };

  const signedIn = { openai: true, anthropic: true };
  let locked = false;
  const events = [];
  const modelPatches = [];
  const dockerExec = async (name, args) => {
    assert.equal(name, container);
    if (args[0] === 'node') {
      if (args[2] === claudeParse.CLAUDE_STATUS_SCRIPT_SRC) {
        return JSON.stringify({
          installed: true,
          status: { loggedIn: signedIn.anthropic, authMethod: 'claude.ai' },
          models: config.agents.defaults.models,
        });
      }
      assert.equal(args[2], subscriptionsParse.STATUS_SCRIPT_SRC);
      if (modelPatches.length) events.push('status');
      return JSON.stringify({
        profiles: signedIn.openai ? [{ id: 'openai:fixture', type: 'oauth' }] : [],
        model: subscriptionsParse.normalizeModel(config.agents.defaults.model),
      });
    }
    if (args[0] === 'timeout') {
      assert.equal(locked, false);
      assert.deepEqual(Array.from(args), isClaude
        ? ['timeout', '60', '/root/.local/bin/claude', 'auth', 'logout']
        : ['timeout', '60', ...gatewayCli.gatewayCliArgv([
          'gateway', 'call', 'models.authLogout', '--params', '{"provider":"openai","profileIds":["openai:fixture"]}', '--json', '--timeout', '55000',
        ])]);
      events.push('logout');
      signedIn[provider] = false;
      return isClaude ? '' : '{"provider":"openai","removedProfiles":["openai:fixture"],"abortedRunIds":[]}';
    }
    assert.deepEqual(Array.from(args), ['sh', '-c', subscriptionsParse.STOP_CODEX_SCRIPT]);
    return '';
  };
  const dockerExecNoFail = async (name, args) => {
    assert.equal(name, container);
    assert.deepEqual(Array.from(args), ['cat', configPath]);
    if (locked) events.push('read-config');
    return JSON.stringify(config);
  };
  const dockerExecWithInput = async (name, args, input) => {
    assert.equal(name, container);
    assert.equal(locked, true, 'config patch holds the lock');
    assert.deepEqual(Array.from(args), Array.from(gatewayCli.gatewayCliArgv(['config', 'patch', '--stdin'])));
    const { agents } = JSON.parse(input);
    if (agents.defaults?.models === null) {
      events.push('remove-rule');
      delete config.agents.defaults.models;
      return '';
    }
    modelPatches.push(input);
    if (agents.list) {
      events.push('write-list');
      if (blockWrite !== 'list') config.agents.list = agents.list;
    } else {
      events.push('write-default');
      if (blockWrite !== 'default') {
        if (agents.defaults.model === null && !keepNull) delete config.agents.defaults.model;
        else config.agents.defaults.model = agents.defaults.model;
      }
    }
    return '';
  };
  const childProcess = {
    execFile: (cmd, args, _opts, callback) => {
      assert.equal(cmd, 'docker');
      assert.equal(args[0], 'ps');
      callback(null, { stdout: `${agentId}\t${container}\trunning` });
    },
  };
  const docker = { dockerExec, dockerExecNoFail, dockerExecWithInput, mapWithConcurrency: (items, _limit, fn) => Promise.all(items.map(fn)) };
  const shared = {
    child_process: childProcess,
    '@/lib/container': { isValidAgentId: (id) => id === agentId },
    '@/lib/docker-exec': docker,
    '@/lib/agent-config-lock': { withAgentConfigLock: async (name, fn) => {
      assert.equal(name, container);
      assert.equal(locked, false, 'the config lock is acquired once at a time');
      locked = true;
      try { return await fn(); } finally { locked = false; }
    } },
    '@/lib/gateway-cli': gatewayCli,
    '@/lib/credentials/native': { OPENCLAW_RELOAD_TIMEOUT_MS: 150_000 },
    '@/lib/subscriptions-parse': subscriptionsParse,
  };
  const globals = {};
  const subscriptions = load('lib/subscriptions.ts', {
    ...shared, util: { promisify },
    '@/lib/agent-names': { getAgentDisplayNames: async () => new Map() },
    '@/lib/agent-versions': { SUPPORTED_VERSIONS: [{ version: '2026.10.10' }] },
    '@/lib/agent-images': {},
    '@/lib/docker-socket-path': {},
    '@/lib/subscription-providers': providers,
  }, globals);
  const claude = load('lib/subscription-claude.ts', {
    ...shared,
    '@/lib/docker-socket': {},
    '@/lib/subscriptions': subscriptions,
    '@/lib/claude-lean-tools': {},
    '@/lib/claude-probe': {},
    '@/lib/claude-sandbox-env': {},
    '@/lib/subscription-claude-parse': claudeParse,
  }, globals);
  const summary = load('app/api/agents/models-summary/route.ts', {
    '@/lib/agent-model-setup': agentModelSetup,
    child_process: childProcess, util: { promisify },
    'next/server': { NextResponse: { json: (body) => body } },
    '@/lib/docker-exec': docker,
    '@/lib/model-catalogue': { loadModelsConfig: () => [], loadOfferedModels: () => [] },
    '@/lib/container-file': {},
    '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
  });
  return {
    config, events, modelPatches, signedIn: (id = provider) => signedIn[id],
    disconnect: () => (isClaude ? claude.disconnectClaudeAgent(agentId) : subscriptions.disconnectAgent(agentId)),
    summary: async () => (await summary.GET({})).agents[0],
  };
}

let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log(`ok   ${name}`);
}

const failedVerification = (error) => error.status === 502 && error.message === 'The model change did not apply as expected. Check the agent panel.';

for (const [provider, service] of [['openai', 'ChatGPT'], ['anthropic', 'Claude']]) {
  const primary = `${provider}/subscription-model`;
  const model = { primary, fallbacks: [] };
  await test(`${provider}: clears the only model, verifies absence, then signs out; summary is unset`, async () => {
    const h = harness(provider, { defaults: { model } });
    assert.equal((await h.disconnect()).removed, 1);
    assert.equal(Object.hasOwn(h.config.agents.defaults, 'model'), false);
    assert.equal(h.config.agents.defaults.workspace, '/workspace');
    assert.deepEqual(h.modelPatches, ['{"agents":{"defaults":{"model":null}}}']);
    const write = h.events.indexOf('write-default');
    assert.deepEqual(h.events.slice(write, write + 2), ['write-default', 'read-config']);
    assert.ok(h.events.indexOf('logout') > write + 1);
    assert.equal(h.signedIn(), false);
    assert.equal(h.signedIn(provider === 'openai' ? 'anthropic' : 'openai'), true);
    const row = await h.summary();
    assert.equal(row.health, 'unset');
    assert.equal(needsModelSetup(row), true);
  });

  await test(`${provider}: promotes the Rev4a fallback and gives main the same home model`, async () => {
    const own = 'rev4a/deepseek/deepseek-flash';
    const next = { primary: own, fallbacks: [] };
    const main = { id: 'main', name: 'Atlas', model };
    const fallbackModel = { primary, fallbacks: [`${provider}/other`, own] };
    const h = harness(provider, { defaults: { model: fallbackModel }, list: [main] });
    assert.equal((await h.disconnect()).removed, 1);
    assert.deepEqual(h.modelPatches, [
      JSON.stringify({ agents: { defaults: { model: next } } }),
      JSON.stringify({ agents: { list: [{ ...main, model: next }] } }),
    ]);
    assert.deepEqual(h.config.agents.defaults.model, next);
    assert.equal(h.signedIn(), false);
  });

  await test(`${provider}: clears the main override and preserves the rest of the list`, async () => {
    const main = { id: 'main', name: 'Atlas' };
    const other = { id: 'other', model: 'rev4a/other' };
    const h = harness(provider, { list: [{ ...main, model: primary }, other] });
    assert.equal((await h.disconnect()).removed, 1);
    assert.deepEqual(h.config.agents.list, [main, other]);
    assert.deepEqual(h.modelPatches, [JSON.stringify({ agents: { list: [main, other] } })]);
    assert.equal(h.signedIn(), false);
  });

  await test(`${provider}: a failed default or main read-back prevents sign-out`, async () => {
    for (const options of [
      { defaults: { model }, blockWrite: 'default' },
      { defaults: { model }, keepNull: true },
      { list: [{ id: 'main', model }], blockWrite: 'list' },
    ]) {
      const h = harness(provider, options);
      await assert.rejects(() => h.disconnect(), failedVerification);
      assert.equal(h.modelPatches.length, 1);
      assert.equal(h.events.includes('remove-rule'), false);
      assert.equal(h.events.includes('logout'), false);
      assert.equal(h.signedIn(), true);
    }
  });

  await test(`${provider}: confirmation describes the no-model outcome and retains the fallback wording`, () => {
    const copy = providerCopy.getProviderCopy(provider);
    assert.ok(copy.disconnectMessage(agentId, null).startsWith(
      `Disconnect ${agentId}? It signs out of ${service} and will have no model until you connect a subscription or add an API key.`,
    ));
    assert.ok(copy.disconnectMessage(agentId, 'deepseek-flash').startsWith(
      `Disconnect ${agentId}? It goes back to deepseek-flash and signs out of ${service}.`,
    ));
  });
}

console.log(`\n${passed} passed`);
