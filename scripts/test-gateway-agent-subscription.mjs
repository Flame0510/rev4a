#!/usr/bin/env node
/**
 * Tests of `PUT /api/gateway/agent` around subscription model references: the ChatGPT mark is
 * unchanged, the Claude mark is accepted and stored as a bare `anthropic/<id>`, bad ids are
 * refused, a Claude mark on an agent without a Claude plan answers 409, and a stored bare
 * `anthropic/<id>` fallback keeps no `rev4a/` prefix. Also tests first-model setup under
 * the real config lock, including configs without defaults.
 *
 * The route runs for real with its Next.js, Docker and subscription dependencies stubbed.
 * Run: node scripts/test-gateway-agent-subscription.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok   ${name}`); }

const routeFile = 'app/api/gateway/agent/route.ts';

/** The same error class shape lib/subscriptions.ts exports, shared by the route and the fixtures. */
class SubscriptionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function loadModule(file, dependencies) {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console,
    Buffer,
    JSON,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', sandbox)(
    (name) => {
      if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}

const configLock = loadModule('lib/agent-config-lock.ts', {});
const modelSetup = loadModule('lib/agent-model-setup.ts', {});

function loadRoute(deps = {}) {
  return loadModule(routeFile, {
    'next/server': {
      NextRequest: class {},
      NextResponse: class NextResponse {
        constructor(body, init) { this.body = body; this.status = init?.status ?? 200; }
        static json(body, init) { return new NextResponse(body, init); }
      },
    },
    '@/lib/agent-busy': { agentBusyReason: async () => null },
    'child_process': { execSync: () => '' },
    '@/lib/agent-config-lock': configLock,
    '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
    '@/lib/subscriptions': {
      readFastStatus: async () => ({ status: 'ok', state: { profiles: [{ id: 'openai:fixture' }] } }),
      statusReadFailedMessage: (reason) => `Could not read this agent's subscription status: ${reason}`,
      SubscriptionError,
      UNSUPPORTED_AGENT_MESSAGE: 'This agent is not on a supported OpenClaw version (2026.9.x). Update it first.',
    },
    '@/lib/subscription-claude': {
      readClaudeAgent: async () => ({ claude: { state: 'connected' } }),
    },
    '@/lib/agent-model-setup': modelSetup,
    ...deps,
  });
}

const config = () => ({
  agents: {
    list: [{ id: 'main', model: { primary: 'rev4a/deepseek-flash', fallbacks: ['anthropic/claude-haiku-5-5'] } }],
    defaults: { model: { primary: 'rev4a/deepseek-flash', fallbacks: ['anthropic/claude-haiku-5-5'] } },
  },
});

/** The route with a real in-memory openclaw.json; every read and write is visible. */
function harness({ claudeState = 'connected', claudeError = null, claudeThrows = false, claudeFailure = null, profiles = [{ id: 'openai:fixture' }], agentId = 'agent_fixture', initialConfig = config() } = {}) {
  let stored = initialConfig;
  const calls = { openai: 0, claude: 0, writes: 0 };
  const execSync = (command, options = {}) => {
    if (command.includes('docker inspect')) return agentId;
    if (command.includes('cat /root/.openclaw/openclaw.json')) return JSON.stringify(stored);
    if (command.includes("cat > /root/.openclaw/openclaw.json")) {
      calls.writes++;
      stored = JSON.parse(options.input);
      return '';
    }
    return '';
  };
  const route = loadRoute({
    'child_process': { execSync },
    '@/lib/subscriptions': {
      readFastStatus: async () => {
        calls.openai++;
        return { status: 'ok', state: { profiles } };
      },
      statusReadFailedMessage: (reason) => `Could not read this agent's subscription status: ${reason}`,
      SubscriptionError,
      UNSUPPORTED_AGENT_MESSAGE: 'This agent is not on a supported OpenClaw version (2026.9.x). Update it first.',
    },
    '@/lib/subscription-claude': {
      readClaudeAgent: async () => {
        calls.claude++;
        if (claudeFailure) throw claudeFailure;
        if (claudeThrows) throw new Error('agent unreadable');
        return { claude: { state: claudeState }, error: claudeError };
      },
    },
  });
  return { route, calls, stored: () => stored };
}

const put = (route, body) => route.PUT({ json: async () => body });
const modelOf = (configValue) => configValue.agents.defaults.model;
const mainModelOf = (configValue) => configValue.agents.list.find((a) => a.id === 'main').model;

await test('anthropic mark: accepted and stored as the bare anthropic/<id>', async () => {
  const h = harness();
  const res = await put(h.route, {
    containerName: 'agent_fixture',
    model: 'subscription:anthropic/claude-haiku-5-5',
    fallbacks: ['rev4a/deepseek-v4-pro'],
  });
  assert.equal(res.status, 200);
  assert.equal(modelOf(h.stored()).primary, 'anthropic/claude-haiku-5-5');
  assert.deepEqual(modelOf(h.stored()).fallbacks, ['rev4a/deepseek-v4-pro']);
  assert.equal(mainModelOf(h.stored()).primary, 'anthropic/claude-haiku-5-5');
  assert.equal(h.calls.claude, 1, 'the Claude state is read once');
  assert.equal(h.calls.openai, 0, 'the ChatGPT status is not read for a Claude mark');
});

await test('anthropic mark: refused with 409 when the agent is not connected to Claude', async () => {
  for (const claudeState of ['not-installed', 'signed-out', 'route-off', 'needs-reconnect']) {
    const h = harness({ claudeState });
    const res = await put(h.route, { containerName: 'agent_fixture', model: 'subscription:anthropic/claude-haiku-5-5' });
    assert.equal(res.status, 409, claudeState);
    assert.equal(res.body.error, 'This agent is not connected to a Claude subscription.');
    assert.equal(h.calls.writes, 0, claudeState);
  }
});

await test('anthropic mark: a generic Claude read failure stays 409 "not connected" (unknown agent)', async () => {
  const h = harness({ claudeThrows: true });
  const res = await put(h.route, { containerName: 'agent_fixture', model: 'subscription:anthropic/claude-haiku-5-5' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'This agent is not connected to a Claude subscription.');
  assert.equal(h.calls.writes, 0);
});

await test('anthropic mark: a SubscriptionError 503 read failure answers 503 with its message, like ChatGPT', async () => {
  const message = "Could not read this agent's subscription status: the read was cut off (timed out)";
  const h = harness({ claudeFailure: new SubscriptionError(503, message) });
  const res = await put(h.route, { containerName: 'agent_fixture', model: 'subscription:anthropic/claude-haiku-5-5' });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, message);
  assert.equal(h.calls.writes, 0);
});

await test('anthropic mark: a row carrying an error is refused (409 unsupported line, 503 for any other error)', async () => {
  const unsupported = 'This agent is not on a supported OpenClaw version (2026.9.x). Update it first.';
  const h = harness({ claudeState: 'not-installed', claudeError: unsupported });
  const res = await put(h.route, { containerName: 'agent_fixture', model: 'subscription:anthropic/claude-haiku-5-5' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, unsupported);
  assert.equal(h.calls.writes, 0);

  for (const claudeState of ['connected', 'route-off']) {
    const failed = harness({ claudeState, claudeError: 'Could not read the agent configuration.' });
    const denied = await put(failed.route, { containerName: 'agent_fixture', model: 'subscription:anthropic/claude-haiku-5-5' });
    assert.equal(denied.status, 503, claudeState);
    assert.equal(denied.body.error, 'Could not read the agent configuration.');
    assert.equal(failed.calls.writes, 0);
  }
});

await test('bad ids: leading dots, path traversal, spaces, slashes and an empty id are refused before any read', async () => {
  for (const model of [
    'subscription:anthropic/..',
    'subscription:anthropic/.',
    'subscription:anthropic/.x',
    'subscription:anthropic/../x',
    'subscription:anthropic/bad id',
    'subscription:anthropic/',
    'subscription:anthropic/a/b',
    'subscription:anthropic',
    'subscription:openai/..',
    'subscription:openai/.',
    'subscription:openai/.x',
    'subscription:openai/../x',
    'subscription:openai/',
  ]) {
    const h = harness();
    const res = await put(h.route, { containerName: 'agent_fixture', model });
    assert.equal(res.status, 400, model);
    assert.equal(res.body.error, 'Invalid subscription model reference', model);
    assert.deepEqual(h.calls, { openai: 0, claude: 0, writes: 0 }, model);
  }
});

await test('good ids: a leading letter or digit, then letters, digits, dots, underscores and hyphens are accepted', async () => {
  for (const model of ['subscription:anthropic/claude-haiku-5-5', 'subscription:openai/gpt-6.1-sol']) {
    const h = harness();
    const res = await put(h.route, { containerName: 'agent_fixture', model });
    assert.equal(res.status, 200, model);
    assert.equal(modelOf(h.stored()).primary, model.slice('subscription:'.length), model);
  }
});

await test('bad ids: a marked fallback is refused too, not only the primary', async () => {
  const h = harness();
  const res = await put(h.route, {
    containerName: 'agent_fixture',
    model: 'rev4a/deepseek-flash',
    fallbacks: ['subscription:anthropic/../x'],
  });
  assert.equal(res.status, 400);
  assert.equal(h.calls.writes, 0);
});

await test('ChatGPT mark: unchanged, stored bare and checked against the ChatGPT sign-in', async () => {
  const h = harness();
  const res = await put(h.route, { containerName: 'agent_fixture', model: 'subscription:openai/gpt-5.6-sol' });
  assert.equal(res.status, 200);
  assert.equal(modelOf(h.stored()).primary, 'openai/gpt-5.6-sol');
  assert.equal(h.calls.openai, 1);
  assert.equal(h.calls.claude, 0);

  const none = harness({ profiles: [] });
  const denied = await put(none.route, { containerName: 'agent_fixture', model: 'subscription:openai/gpt-5.6-sol' });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error, 'This agent is not connected to a ChatGPT subscription.');
  assert.equal(none.calls.writes, 0);
});

await test('stored bare anthropic/<id> refs keep no rev4a/ prefix when fallbacks are omitted', async () => {
  const h = harness();
  const res = await put(h.route, { containerName: 'agent_fixture', model: 'rev4a/deepseek-flash' });
  assert.equal(res.status, 200);
  assert.deepEqual(modelOf(h.stored()).fallbacks, ['anthropic/claude-haiku-5-5']);
  assert.deepEqual(mainModelOf(h.stored()).fallbacks, ['anthropic/claude-haiku-5-5']);
});

await test('stored bare openai/<id> refs still keep no rev4a/ prefix', async () => {
  const h = harness();
  h.stored().agents.defaults.model.fallbacks = ['openai/gpt-5.6-sol'];
  h.stored().agents.list[0].model.fallbacks = ['openai/gpt-5.6-sol'];
  const res = await put(h.route, { containerName: 'agent_fixture', model: 'rev4a/deepseek-flash' });
  assert.equal(res.status, 200);
  assert.deepEqual(modelOf(h.stored()).fallbacks, ['openai/gpt-5.6-sol']);
});

await test('an unmarked anthropic/… id is still a Rev4a catalogue model and gains rev4a/', async () => {
  const h = harness();
  const res = await put(h.route, { containerName: 'agent_fixture', model: 'anthropic/claude-haiku-5-5' });
  assert.equal(res.status, 200);
  assert.equal(modelOf(h.stored()).primary, 'rev4a/anthropic/claude-haiku-5-5');
});

const setup = {
  containerName: 'agent_fixture',
  model: 'subscription:openai/gpt-6-astra',
  fallbacks: [],
  onlyIfUnset: true,
};

await test('guarded setup loses to a queued manual save and preserves its primary and fallbacks', async () => {
  const h = harness({ initialConfig: { agents: { defaults: {} } } });
  const manual = { primary: 'rev4a/deepseek/selected-by-user', fallbacks: ['rev4a/deepseek/another'] };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const lock = configLock.withAgentConfigLock(setup.containerName, () => held);
  const manualSave = put(h.route, { containerName: setup.containerName, model: manual.primary, fallbacks: manual.fallbacks });
  const automaticSave = put(h.route, setup);
  release();
  await lock;
  assert.equal((await manualSave).status, 200);
  const result = await automaticSave;
  assert.equal(result.status, 409);
  assert.deepEqual({ ...result.body }, {
    status: 'error',
    code: 'model-already-set',
    error: 'This agent already has a model.',
  });
  assert.equal(h.calls.writes, 1);
  assert.deepEqual(modelOf(h.stored()), manual);
  console.log('     ' + JSON.stringify({ httpStatus: result.status, ...result.body, writes: h.calls.writes, model: modelOf(h.stored()) }));
});

for (const [location, agents] of [
  ['defaults only', { defaults: { model: 'legacy/model' } }],
  ['list main only', { list: [{ id: 'main', model: { primary: 'list/model' } }] }],
  ['entries.main only', { entries: { main: { model: 'entries/model' } } }],
]) {
  await test(`guarded setup preserves an existing primary in ${location}`, async () => {
    const initialConfig = { agents };
    const h = harness({ initialConfig });
    const result = await put(h.route, setup);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'model-already-set');
    assert.equal(h.calls.writes, 0);
    assert.deepEqual(h.stored(), initialConfig);
  });
}

await test('guarded setup reports an existing primary even if the subscription signed out', async () => {
  const h = harness({ profiles: [] });
  const result = await put(h.route, setup);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'model-already-set');
  assert.equal(h.calls.writes, 0);
});

await test('guarded setup writes when there is no effective primary and creates missing defaults or agents', async () => {
  for (const initialConfig of [
    { agents: { defaults: { model: { primary: '' } } } },
    { agents: { list: [{ id: 'other', model: 'other/model' }, { id: 'main' }] } },
    { agents: { defaults: {}, entries: { main: { model: {} } } } },
    {},
  ]) {
    const h = harness({ initialConfig });
    const result = await put(h.route, setup);
    assert.equal(result.status, 200);
    assert.equal(result.body.verify.ok, true);
    assert.equal(h.calls.writes, 1);
    assert.deepEqual(modelOf(h.stored()), { primary: 'openai/gpt-6-astra', fallbacks: [] });
    if (initialConfig.agents?.list) assert.deepEqual(mainModelOf(h.stored()), modelOf(h.stored()));
    console.log('     ' + JSON.stringify({ status: result.status, verify: result.body.verify, writes: h.calls.writes, model: modelOf(h.stored()) }));
  }
});

await test('a normal PUT can still replace an existing primary', async () => {
  const h = harness();
  const { containerName, model, fallbacks } = setup;
  const result = await put(h.route, { containerName, model, fallbacks });
  assert.equal(result.status, 200);
  assert.equal(h.calls.writes, 1);
  assert.deepEqual(modelOf(h.stored()), { primary: 'openai/gpt-6-astra', fallbacks: [] });
});

await test('guarded setup keeps fallbacks already stored on the agent (defaults and main entry)', async () => {
  const h = harness({ initialConfig: { agents: {
    defaults: { model: { fallbacks: ['rev4a/keep-default'] } },
    list: [{ id: 'main', model: { fallbacks: ['rev4a/keep-main'] } }],
  } } });
  const res = await put(h.route, { ...setup, fallbacks: [] });
  assert.equal(res.status, 200);
  const stored = h.stored();
  assert.deepEqual(stored.agents.defaults.model, { primary: 'openai/gpt-6-astra', fallbacks: ['rev4a/keep-default'] });
  assert.deepEqual(stored.agents.list[0].model, { primary: 'openai/gpt-6-astra', fallbacks: ['rev4a/keep-main'] });
});

console.log(`\n${passed} passed`);
