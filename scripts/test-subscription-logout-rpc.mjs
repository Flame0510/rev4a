#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const subscriptionsParse = require('../lib/subscriptions-parse.js');
const { parseAuthLogout, STATUS_SCRIPT_SRC, STOP_CODEX_SCRIPT, normalizeModel } = subscriptionsParse;

const agentId = 'atlas';
const container = 'agent-atlas';
const profileIds = ['openai:first@example.test', "openai:second+'$literal@example.test"];
const oauthProfiles = profileIds.map((id) => ({ id, type: 'oauth' }));
const unrelatedProfiles = [
  { id: 'openai:manual', type: 'api_key' },
  { id: 'anthropic:fixture', type: 'oauth' },
];
const invalidProfile = { id: 'openai:with space', type: 'oauth' };
const response = (removedProfiles) => JSON.stringify({ provider: 'openai', removedProfiles, abortedRunIds: [] }, null, 2);
const errorOutput = JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'profileIds contain unavailable auth profiles' } });

test('parses clean JSON and JSON surrounded by CLI notices', () => {
  const expected = { ok: true, removed: profileIds };
  assert.deepEqual(parseAuthLogout(response(profileIds), profileIds), expected);
  assert.deepEqual(parseAuthLogout(`OpenClaw Gateway\n${response(profileIds)}\nDeprecationWarning: example\n`, profileIds), expected);
});

test('skips an unmatched opening brace in a warning before the logout answer', () => {
  assert.deepEqual(parseAuthLogout(`Warning: malformed line {\n${response(profileIds)}`, profileIds), {
    ok: true, removed: profileIds,
  });
});

test('rejects partial, empty, malformed and error responses', () => {
  for (const output of [response(profileIds.slice(0, 1)), response([]), 'garbage', errorOutput, response([...profileIds, 42])]) {
    assert.deepEqual(parseAuthLogout(output, profileIds), { ok: false });
  }
});

function transpile(file) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function load(code, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, globalThis: globals, setTimeout, clearTimeout,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency: ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}

const subscriptionsCode = transpile('lib/subscriptions.ts');
const gatewayCli = load(transpile('lib/gateway-cli.ts'));
const providers = load(transpile('lib/subscription-providers.ts'));

function harness({ profiles = [...oauthProfiles, ...unrelatedProfiles], after = unrelatedProfiles,
  rpcOutput = response(profileIds), rpcError, blockModelWrite = false } = {}) {
  const config = { agents: { defaults: { model: { primary: 'openai/subscription', fallbacks: ['rev4a/home'] } } } };
  const events = [];
  const rpcCalls = [];
  const gatewayCalls = [];
  const globals = {};
  const subscriptions = load(subscriptionsCode, {
    child_process: { execFile: (cmd, args, _opts, callback) => {
      assert.equal(cmd, 'docker');
      assert.equal(args[0], 'ps');
      callback(null, { stdout: `${agentId}\t${container}\trunning` });
    } },
    util: { promisify },
    '@/lib/agent-names': { getAgentDisplayNames: async () => new Map() },
    '@/lib/agent-versions': { SUPPORTED_VERSIONS: [{ version: '2026.9.9' }, { version: '2026.10.10' }] },
    '@/lib/agent-images': {},
    '@/lib/docker-socket-path': {},
    '@/lib/container': { isValidAgentId: (id) => id === agentId },
    '@/lib/agent-config-lock': { withAgentConfigLock: async (_name, fn) => fn() },
    '@/lib/credentials/native': { OPENCLAW_RELOAD_TIMEOUT_MS: 150_000 },
    '@/lib/subscription-providers': providers,
    '@/lib/subscriptions-parse': subscriptionsParse,
    '@/lib/gateway-cli': { gatewayCliArgv(args) {
      gatewayCalls.push(Array.from(args));
      return gatewayCli.gatewayCliArgv(args);
    } },
    '@/lib/docker-exec': {
      async dockerExec(name, args, opts) {
        assert.equal(name, container);
        assert.ok(globals.__rev4aSubMutating.has(agentId));
        if (args[0] === 'node') {
          assert.deepEqual(Array.from(args), ['node', '-e', STATUS_SCRIPT_SRC]);
          events.push(rpcCalls.length ? 'read-back' : 'read-status');
          return JSON.stringify({ profiles, model: normalizeModel(config.agents.defaults.model) });
        }
        if (args[0] === 'timeout') {
          events.push('logout-rpc');
          rpcCalls.push({ args: Array.from(args), timeoutMs: opts.timeoutMs });
          if (rpcError) throw rpcError;
          profiles = after;
          return rpcOutput;
        }
        assert.deepEqual(Array.from(args), ['sh', '-c', STOP_CODEX_SCRIPT]);
        events.push('stop-codex');
        return '';
      },
      async dockerExecNoFail(name, args) {
        assert.equal(name, container);
        assert.deepEqual(Array.from(args), ['cat', '/root/.openclaw/openclaw.json']);
        return JSON.stringify(config);
      },
      async dockerExecWithInput(name, args, input) {
        assert.equal(name, container);
        assert.deepEqual(Array.from(args), Array.from(gatewayCli.gatewayCliArgv(['config', 'patch', '--stdin'])));
        events.push('write-model');
        if (!blockModelWrite) config.agents.defaults.model = JSON.parse(input).agents.defaults.model;
        return '';
      },
    },
  }, globals);
  return { disconnect: () => subscriptions.disconnectAgent(agentId), events, rpcCalls, gatewayCalls };
}

test('sends one timed Gateway call for the matching profiles, reads back and stops Codex', async () => {
  const h = harness({ profiles: [...oauthProfiles, invalidProfile, ...unrelatedProfiles] });
  assert.equal((await h.disconnect()).removed, 2);
  const [call] = h.rpcCalls;
  assert.equal(h.rpcCalls.length, 1);
  const args = ['gateway', 'call', 'models.authLogout', '--params', JSON.stringify({ provider: 'openai', profileIds }), '--json', '--timeout', '55000'];
  assert.deepEqual(h.gatewayCalls, [['config', 'patch', '--stdin'], args]);
  assert.deepEqual(call.args, ['timeout', '60', ...gatewayCli.gatewayCliArgv(args)]);
  assert.equal(call.timeoutMs, 70_000);
  assert.deepEqual(h.events, ['read-status', 'write-model', 'read-status', 'read-status', 'logout-rpc', 'read-back', 'stop-codex']);
});

test('RPC errors, invalid output and missing removals fail with the fixed 502 message', async () => {
  for (const options of [
    { rpcError: new Error(`RPC failed for ${profileIds[0]}`) },
    { rpcOutput: 'garbage' },
    { rpcOutput: errorOutput },
    { rpcOutput: response(profileIds.slice(0, 1)) },
  ]) {
    const h = harness(options);
    await assert.rejects(h.disconnect, { status: 502, message: 'The agent could not sign out. Try again.' });
    assert.equal(h.rpcCalls.length, 1);
    assert.equal(h.events.at(-1), 'logout-rpc');
  }
});

test('a remaining profile in the read-back fails the disconnect', async () => {
  const h = harness({ after: [oauthProfiles[0], ...unrelatedProfiles] });
  await assert.rejects(h.disconnect, { status: 502, message: 'The sign-out did not complete. Try again.' });
  assert.deepEqual(h.events.slice(-2), ['logout-rpc', 'read-back']);
});

test('a failed model verification prevents sign-out', async () => {
  const h = harness({ blockModelWrite: true });
  await assert.rejects(h.disconnect, { status: 502, message: 'The model change did not apply as expected. Check the agent panel.' });
  assert.deepEqual(h.events, ['read-status', 'write-model', 'read-status']);
  assert.equal(h.rpcCalls.length, 0);
});

test('zero matching profiles skips the RPC and Codex stop', async () => {
  const h = harness({ profiles: unrelatedProfiles });
  assert.equal((await h.disconnect()).removed, 0);
  assert.equal(h.rpcCalls.length, 0);
  assert.deepEqual(h.events, ['read-status', 'write-model', 'read-status', 'read-status', 'read-status']);
});

test('the logout answer is found among notices, log lines and braces in strings', () => {
  const ids = ['openai:a@example.test', 'openai:b@example.test'];
  const answer = JSON.stringify({ provider: 'openai', removedProfiles: ids, abortedRunIds: [] }, null, 2);
  const ok = { ok: true, removed: ids };
  assert.deepEqual(parseAuthLogout(`Deprecation {plugins} notice\n${answer}`, ids), ok);
  assert.deepEqual(parseAuthLogout(`${answer}\n{"level":"info","msg":"done"}`, ids), ok);
  assert.deepEqual(parseAuthLogout(`${answer}\nhint: see {docs}`, ids), ok);
  assert.deepEqual(parseAuthLogout(JSON.stringify({ note: 'a } b {', removedProfiles: ids }), ids), ok);
  // Duplicates in the request and extra ids in the answer do not change the count.
  assert.deepEqual(parseAuthLogout(JSON.stringify({ removedProfiles: [...ids, 'openai:c@example.test'] }), [...ids, ids[0]]), ok);
  // An error envelope is a failure even when it lists the ids.
  assert.deepEqual(parseAuthLogout(JSON.stringify({ ok: false, error: { code: 'X' }, removedProfiles: ids }), ids), { ok: false });
  assert.deepEqual(parseAuthLogout(JSON.stringify({ removedProfiles: [ids[0]] }), ids), { ok: false });
  assert.deepEqual(parseAuthLogout('{ unterminated', ids), { ok: false });
});

test('pathological output with many open braces fails fast and safely', () => {
  const answer = JSON.stringify({ removedProfiles: ['openai:a@example.test'] });
  const started = Date.now();
  assert.deepEqual(parseAuthLogout('{'.repeat(64000) + answer, ['openai:a@example.test']), { ok: false });
  assert.ok(Date.now() - started < 1000, 'bounded scan');
});
