import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import ts from 'typescript';

function transpile(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const modelHelpers = {};
new Function('exports', transpile('../lib/agent-model-setup.ts'))(modelHelpers);
const setupModule = transpile('../app/subscriptions/subscription-model-setup.ts');

const AGENT_ID = 'atlas+test';
const EMAIL = 'member+test@example.com';
const KEY = 'openai/gpt-6.1-sol';
const MODEL = { key: KEY, name: 'GPT-6.1 Sol' };
const LOGIN_BUSY = 'A subscription login for this agent is running';
const json = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const offered = () => json({ models: [MODEL] });
const saved = () => json({ status: 'ok', verify: { ok: true } });
const busy = () => json({ status: 'error', error: LOGIN_BUSY }, 409);
const stall = (signal) => new Promise((_, reject) => {
  signal.throwIfAborted();
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

function harness(handle, provider = 'openai', controller = new AbortController()) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const requests = [];
  const phases = [];
  const later = (callback, delay) => {
    const id = nextTimer++;
    timers.set(id, { id, at: now + delay, callback });
    return id;
  };
  const fetch = async (url, options) => {
    const request = { url, options, at: now };
    requests.push(request);
    return handle(request, requests.length, later);
  };
  const exports = {};
  new Function('exports', 'require', 'fetch', 'setTimeout', 'clearTimeout', 'performance', setupModule)(
    exports,
    (path) => {
      assert.equal(path, '@/lib/agent-model-setup');
      return modelHelpers;
    },
    fetch,
    later,
    (id) => timers.delete(id),
    { now: () => now },
  );

  async function tick(delay) {
    const until = now + delay;
    await setImmediate();
    for (;;) {
      const next = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next || next.at > until) break;
      now = next.at;
      timers.delete(next.id);
      next.callback();
      await setImmediate();
    }
    now = until;
  }

  const result = exports.setupSubscriptionModel({
    agentId: AGENT_ID, provider, email: EMAIL, signal: controller.signal, onProgress: (phase) => phases.push(phase),
  });
  return { result, tick, requests, phases, controller, timers };
}

test('polls this agent’s catalogue and saves its preferred subscription model', async () => {
  const setup = harness(({ url }, number) => {
    if (url === '/api/gateway/agent') return saved();
    return number === 1
      ? json({ pending: true })
      : json({ models: [{ key: 'openai/other', name: 'Other' }, MODEL] });
  });
  assert.deepEqual(setup.phases, ['waiting']);
  await setup.tick(4_999);
  assert.equal(setup.requests.length, 1);
  await setup.tick(1);
  assert.deepEqual(await setup.result, { kind: 'set', ...MODEL });
  assert.deepEqual(setup.phases, ['waiting', 'setting']);
  const [first, second, put] = setup.requests;
  assert.equal(first.url, '/api/subscriptions/models?provider=openai&agentId=atlas%2Btest');
  assert.equal(second.url, first.url);
  assert.equal(second.at, 5_000);
  assert.equal(put.options.method, 'PUT');
  assert.deepEqual(JSON.parse(put.options.body), {
    containerName: AGENT_ID, model: `subscription:${KEY}`, fallbacks: [], onlyIfUnset: true,
  });
  assert.equal(setup.timers.size, 0);
});

test('a model saved elsewhere counts as already set', async () => {
  const setup = harness(({ url }) => url === '/api/gateway/agent'
    ? json({ code: 'model-already-set' }, 409) : offered());
  assert.deepEqual(await setup.result, { kind: 'already-set' });
  assert.equal(setup.requests.length, 2);
});

test('Claude checks fresh usage for the signed-in account and stops when terms are required', async () => {
  const setup = harness(({ url }) => {
    assert.equal(url, '/api/subscriptions/usage?provider=anthropic&refresh=1&email=member%2Btest%40example.com');
    return json({ errors: [{ email: EMAIL, code: 'terms-required' }] });
  }, 'anthropic');
  assert.deepEqual(await setup.result, { kind: 'terms-required' });
  assert.equal(setup.requests.length, 1);
  assert.deepEqual(setup.phases, ['waiting']);
});

test('a stalled Claude terms check gives way to the agent’s catalogue after 15 seconds', async () => {
  const model = { key: 'anthropic/sonnet-test', name: 'Sonnet' };
  const setup = harness(({ url, options }) => {
    if (url.startsWith('/api/subscriptions/usage')) return { ok: true, json: () => stall(options.signal) };
    if (url === '/api/gateway/agent') return saved();
    assert.equal(url, '/api/subscriptions/models?provider=anthropic&agentId=atlas%2Btest');
    return json({ models: [{ key: 'anthropic/opus-test', name: 'Opus' }, model] });
  }, 'anthropic');
  await setup.tick(14_999);
  assert.equal(setup.requests.length, 1);
  await setup.tick(1);
  assert.equal(setup.requests[0].options.signal.aborted, true);
  assert.deepEqual(await setup.result, { kind: 'set', ...model });
});

test('a busy login retries in 2 seconds and retains the saving phase', async () => {
  const setup = harness(({ url }, number) => url === '/api/gateway/agent'
    ? (number === 2 ? busy() : saved()) : offered());
  await setup.tick(1_999);
  assert.equal(setup.requests.length, 2);
  await setup.tick(1);
  assert.deepEqual(await setup.result, { kind: 'set', ...MODEL });
  assert.deepEqual(setup.phases, ['waiting', 'setting']);
  assert.deepEqual(setup.requests.slice(1).map(({ at }) => at), [0, 2_000]);
});

test('a busy login cannot start a new save at or after 30 seconds', async () => {
  const setup = harness(({ url }) => url === '/api/gateway/agent' ? busy() : offered());
  await setup.tick(30_000);
  assert.deepEqual(await setup.result, { kind: 'error', message: LOGIN_BUSY });
  const putTimes = setup.requests.slice(1).map(({ at }) => at);
  assert.equal(putTimes.length, 15);
  assert.equal(putTimes.at(-1), 28_000);
  assert.equal(setup.timers.size, 0);
});

test('a save sent before the retry deadline can succeed after it', async () => {
  const setup = harness(({ url, at }, _, later) => {
    if (url !== '/api/gateway/agent') return offered();
    if (at < 28_000) return busy();
    return new Promise((resolve) => later(() => resolve(saved()), 5_000));
  });
  await setup.tick(32_999);
  assert.equal(setup.requests.at(-1).at, 28_000);
  assert.equal(setup.requests.at(-1).options.signal.aborted, false);
  await setup.tick(1);
  assert.deepEqual(await setup.result, { kind: 'set', ...MODEL });
});

test('a stalled save body reports the 60-second timeout without retrying', async () => {
  const setup = harness(({ url, options }) => url === '/api/gateway/agent'
    ? { ...saved(), json: () => stall(options.signal) } : offered());
  await setup.tick(59_999);
  assert.equal(setup.requests[1].options.signal.aborted, false);
  await setup.tick(1);
  assert.deepEqual(await setup.result, { kind: 'error', message: 'The model save did not answer in time. Check the Model section.' });
  assert.equal(setup.requests[1].options.signal.aborted, true);
  assert.equal(setup.requests.length, 2);
});

test('pending catalogue polls stop at two minutes', async () => {
  const setup = harness(() => json({ pending: true }));
  await setup.tick(120_000);
  assert.deepEqual(await setup.result, { kind: 'error', message: "Timed out waiting for the account's models." });
  assert.equal(setup.requests.length, 24);
  assert.equal(setup.requests.at(-1).at, 115_000);
  assert.deepEqual(setup.phases, ['waiting']);
  assert.equal(setup.timers.size, 0);
});

test('the catalogue deadline also aborts an outstanding request', async () => {
  const setup = harness(({ options }) => stall(options.signal));
  await setup.tick(120_000);
  assert.deepEqual(await setup.result, { kind: 'error', message: "Timed out waiting for the account's models." });
  assert.equal(setup.requests[0].options.signal.aborted, true);
});

test('a catalogue with no matching model reports the original message without saving', async () => {
  const setup = harness(() => json({ models: [{ key: 'anthropic/other', name: 'Other' }] }));
  assert.deepEqual(await setup.result, { kind: 'error', message: 'The account did not offer a subscription model.' });
  assert.equal(setup.requests.length, 1);
});

test('an unrelated 409 and a failed verification report the save error immediately', async () => {
  for (const answer of [json({ error: 'Agent is updating' }, 409), json({ status: 'ok', verify: { ok: false } })]) {
    const setup = harness(({ url }) => url === '/api/gateway/agent' ? answer : offered());
    const message = answer.status === 409 ? 'Agent is updating' : 'Could not set the model.';
    assert.deepEqual(await setup.result, { kind: 'error', message });
    assert.equal(setup.requests.length, 2);
    assert.equal(setup.timers.size, 0);
  }
});

test('abort stops terms checks, model polls, saves and both retry waits', async () => {
  const cases = [
    { provider: 'anthropic', handle: ({ options }) => stall(options.signal), requests: 1, inFlight: true },
    { provider: 'openai', handle: ({ options }) => stall(options.signal), requests: 1, inFlight: true },
    { provider: 'openai', handle: () => json({ pending: true }), requests: 1, inFlight: true },
    { provider: 'openai', handle: ({ url, options }) => url === '/api/gateway/agent' ? stall(options.signal) : offered(), requests: 2, inFlight: true },
    { provider: 'openai', handle: ({ url }) => url === '/api/gateway/agent' ? busy() : offered(), requests: 2, inFlight: false },
  ];
  for (const { provider, handle, requests, inFlight } of cases) {
    const setup = harness(handle, provider);
    await setup.tick(0);
    const rejected = assert.rejects(setup.result, { name: 'AbortError' });
    setup.controller.abort();
    await rejected;
    if (inFlight) assert.equal(setup.requests.at(-1).options.signal.aborted, true);
    assert.equal(setup.timers.size, 0);
    await setup.tick(180_000);
    assert.equal(setup.requests.length, requests);
  }
});

test('an already-aborted action makes no requests and reports no progress', async () => {
  const setup = harness(() => assert.fail('Unexpected request'), 'openai', { signal: AbortSignal.abort() });
  await assert.rejects(setup.result, { name: 'AbortError' });
  assert.deepEqual(setup.phases, []);
});
