#!/usr/bin/env node
/** Actual model cache and both UI retry loops, with mocked transport and a deterministic clock. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseModelList } = require('../lib/subscriptions-parse.js');
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
function ast(file) { return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS); }
function run(source, deps) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, ...deps }); return module.exports;
}
const serverAst = ast('lib/subscriptions.ts');
const serverSource = ['readAccountModels', 'getSubscriptionModels'].map(name => serverAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(serverAst)).join('\n') + '\nmodule.exports = { getSubscriptionModels };';
function server({ connected = true, fail = false } = {}) {
  const cache = new Map(); let calls = 0;
  const models = [{ key: 'openai/fixture-model', name: 'Fixture model', contextWindow: 100000 }];
  const api = run(serverSource, {
    generation: () => 1, modelsCache: () => cache, MODELS_TTL_MS: 600000, CLI_TIMEOUT_MS: 25000, PROVIDER_ID: 'openai', parseModelList,
    findAccountSources: async () => new Map(connected ? [['fixture@example.invalid', { container: 'fixture' }]] : []),
    gatewayCliArgv: args => args, dockerExec: async () => { calls++; if (fail) throw new Error('unavailable'); return JSON.stringify({ models: calls === 1 ? [] : models }); },
  });
  return { ...api, cache, calls: () => calls, models };
}
await test('empty catalogue answers pending and is not cached; the next read finds and caches the models', async () => {
  const s = server(); assert.deepEqual(plain(await s.getSubscriptionModels()), { models: [], error: null, pending: true }); assert.equal(s.cache.size, 0);
  assert.deepEqual(plain(await s.getSubscriptionModels()), { models: s.models, error: null, pending: false }); assert.equal(s.calls(), 2); assert.equal(s.cache.size, 1);
  await s.getSubscriptionModels(); assert.equal(s.calls(), 2, 'non-empty catalogue is still cached');
});
await test('an empty cache entry left by older code is ignored', async () => {
  const s = server(); s.cache.set('fixture@example.invalid', { at: Date.now(), models: [] });
  assert.equal((await s.getSubscriptionModels()).pending, true); assert.equal(s.calls(), 1);
  assert.equal((await s.getSubscriptionModels()).models.length, 1); assert.equal(s.calls(), 2);
});
await test('no connected account and a failed CLI read are not pending', async () => {
  const none = server({ connected: false }); assert.deepEqual(plain(await none.getSubscriptionModels()), { models: [], error: null, pending: false }); assert.equal(none.calls(), 0);
  const failed = server({ fail: true }); const result = await failed.getSubscriptionModels(); assert.equal(result.pending, false); assert.match(result.error, /Could not read/); assert.equal(failed.cache.size, 0);
});
for (const other of ['ready', 'failed']) await test(`${other} account does not suppress pending for another account`, async () => {
  const calls = new Map(), cache = new Map();
  let loaded = false;
  const model = { key: 'openai/fixture-model', name: 'Fixture model', contextWindow: 100000 };
  const s = run(serverSource, {
    generation: () => 1, modelsCache: () => cache, MODELS_TTL_MS: 600000, CLI_TIMEOUT_MS: 25000, PROVIDER_ID: 'openai', parseModelList,
    findAccountSources: async () => new Map([[other, { container: other }], ['loading', { container: 'loading' }]]),
    gatewayCliArgv: args => args,
    dockerExec: async container => {
      calls.set(container, (calls.get(container) ?? 0) + 1);
      if (container === 'failed') throw new Error('unavailable');
      return JSON.stringify({ models: container === 'loading' && !loaded ? [] : [model] });
    },
  });
  const first = plain(await s.getSubscriptionModels());
  assert.equal(first.pending, true);
  assert.deepEqual(first.models, other === 'ready' ? [model] : []);
  if (other === 'failed') assert.match(first.error, /Could not read/);
  loaded = true;
  const second = plain(await s.getSubscriptionModels());
  assert.equal(second.pending, false); assert.deepEqual(second.models, [model]);
  assert.equal(calls.get('loading'), 2);
  if (other === 'ready') assert.equal(calls.get('ready'), 1, 'ready account stays cached while the loading account retries');
});
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function ui(kind, response = () => ({ models: [], error: null, pending: true })) {
  const file = kind === 'agent' ? 'app/agents/ModelSection.tsx' : 'app/subscriptions/PageClient.tsx';
  const tree = ast(file);
  const component = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === (kind === 'agent' ? 'ModelSection' : 'SubscriptionsPageClient'));
  const constants = tree.statements.filter(n => ts.isVariableStatement(n) && /(?:SUB_)?MODELS_(?:RETRY|WAIT)_MS/.test(n.getText(tree))).map(n => n.getText(tree)).join('\n');
  let declaration;
  if (kind === 'agent') declaration = component.body.statements.find(n => ts.isExpressionStatement(n) && n.expression.expression?.getText(tree) === 'useEffect' && n.getText(tree).includes('/api/subscriptions/models')).getText(tree);
  else declaration = component.body.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree) === 'loadModels')).getText(tree) + '\nmodule.exports = { start: loadModels };';
  let clock = 0, sequence = 0, calls = 0, cleanup;
  const timers = new Map(), states = [], errors = [], signals = [], modelsAbort = { current: null }, modelsTimer = { current: null }, alive = { current: true };
  let state = kind === 'agent' ? null : { list: [], error: null, loading: true, pending: false };
  const setState = value => { state = typeof value === 'function' ? value(state) : value; states.push(plain(state)); };
  const deps = {
    Date: { now: () => clock }, AbortController, subConnected: true, agentId: 'agent_fixture', alive, modelsAbort, modelsTimer, modelsAbortRef: modelsAbort,
    useEffect: fn => { cleanup = fn(); }, useCallback: fn => fn,
    setSubModels: setState, setSubModelsError: value => errors.push(value), setModels: setState,
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: clock + delay }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (_url, opts) => { calls++; signals.push(opts.signal); const json = await response(calls); return json?.response ?? { ok: true, json: async () => json }; }, readJson: async res => res.json(),
  };
  const api = run(constants + '\n' + declaration, deps);
  if (kind === 'page') { void api.start(); cleanup = () => { alive.current = false; modelsAbort.current?.abort(); if (modelsTimer.current) deps.clearTimeout(modelsTimer.current); }; }
  return { states, errors, timers, signals, calls: () => calls, cleanup, restart: api.start,
    advance: async ms => {
      const end = clock + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        clock = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      clock = end; await flush();
    },
  };
}
for (const kind of ['agent', 'page']) {
  await test(`${kind}: pending retries stop at three minutes, clear loading, and explain how to retry`, async () => {
    const u = ui(kind); await flush(); assert.equal(u.calls(), 1); assert.equal(u.timers.size, 2);
    await u.advance(179999); const before = u.calls(); assert.ok(before > 1); assert.equal(u.timers.size, 2);
    await u.advance(1); assert.equal(u.calls(), before, 'no request starts at the deadline'); assert.equal(u.timers.size, 0);
    if (kind === 'agent') { assert.deepEqual(u.states.at(-1), []); assert.match(u.errors.at(-1), /still unavailable/); }
    else { assert.equal(u.states.at(-1).pending, false); assert.equal(u.states.at(-1).loading, false); assert.match(u.states.at(-1).error, /still unavailable/); }
    await u.advance(600000); assert.equal(u.calls(), before);
  });
  for (const phase of ['fetch', 'body']) await test(`${kind}: deadline aborts a hanging ${phase} read and ignores its late result`, async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const u = ui(kind, calls => calls === 1 ? { models: [], pending: true } : phase === 'fetch' ? waiting : { response: { ok: true, json: () => waiting } });
    await flush(); await u.advance(5000); assert.equal(u.calls(), 2); assert.equal(u.signals.at(-1).aborted, false);
    await u.advance(175000); assert.equal(u.signals.at(-1).aborted, true); assert.equal(u.timers.size, 0);
    if (kind === 'agent') { assert.deepEqual(u.states.at(-1), []); assert.match(u.errors.at(-1), /still unavailable/); }
    else { assert.equal(u.states.at(-1).pending, false); assert.equal(u.states.at(-1).loading, false); assert.match(u.states.at(-1).error, /still unavailable/); }
    const before = JSON.stringify([u.states, u.errors]); release({ models: [{ key: 'openai/late' }], pending: false }); await flush();
    assert.equal(JSON.stringify([u.states, u.errors]), before);
    await u.advance(600000); assert.equal(u.calls(), 2);
  });
  await test(`${kind}: partial models stay available while another account retries and after its deadline`, async () => {
    const available = [{ key: 'openai/ready' }];
    const u = ui(kind, () => ({ models: available, pending: true, error: null })); await flush();
    assert.deepEqual(kind === 'agent' ? u.states.at(-1) : u.states.at(-1).list, available);
    await u.advance(180000); assert.ok(u.calls() > 1); assert.equal(u.timers.size, 0);
    assert.deepEqual(kind === 'agent' ? u.states.at(-1) : u.states.at(-1).list, available);
  });
  await test(`${kind}: a successful retry ends polling immediately`, async () => {
    const u = ui(kind, calls => ({ models: calls === 1 ? [] : [{ key: 'openai/fixture-model' }], error: null, pending: calls === 1 }));
    await flush(); await u.advance(5000); assert.equal(u.calls(), 2); assert.equal(u.timers.size, 0); await u.advance(180000); assert.equal(u.calls(), 2);
  });
  await test(`${kind}: unmount cancels scheduled retries and ignores a late response`, async () => {
    const u = ui(kind); await flush(); u.cleanup(); await u.advance(180000); assert.equal(u.calls(), 1); assert.equal(u.timers.size, 0);
    let release; const waiting = ui(kind, () => new Promise(resolve => { release = resolve; })); await flush();
    waiting.cleanup(); const before = JSON.stringify([waiting.states, waiting.errors]); release({ models: [], pending: true }); await flush();
    assert.equal(JSON.stringify([waiting.states, waiting.errors]), before); assert.equal(waiting.timers.size, 0);
  });
}
await test('page: refresh cancels the old deadline and outstanding request', async () => {
  const u = ui('page', () => new Promise(() => {})); await flush();
  const old = u.signals.at(-1); void u.restart(); await flush();
  assert.equal(old.aborted, true); assert.equal(u.timers.size, 1);
  u.cleanup(); assert.equal(u.signals.at(-1).aborted, true); assert.equal(u.timers.size, 0);
});
console.log(`\n${passed} passed`);
