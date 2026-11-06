#!/usr/bin/env node
/** Actual RecreateSection discovery/poll callbacks with controlled hooks and responses. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('app/agents/PageClient.tsx', 'utf8');
const ast = ts.createSourceFile('PageClient.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const section = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'RecreateSection');
const statements = section.body.statements.filter(n => !ts.isReturnStatement(n));
const compiled = ts.transpileModule(statements.map(n => n.getText(ast)).join('\n')
  + '\nmodule.exports = { startPolling };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(current) {
  const state = {}, intervals = new Map(), effects = [];
  const names = ['job', 'starting', 'error', 'toast', 'warning', 'showConfirm'];
  let stateIndex = 0, timerId = 0, cleanup, fetcher = async () => ({ ok: true, json: async () => ({ recreate: current }) });
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, AbortController, agentName: 'fixture', onRecreated() {}, onStarted() {},
    useState: initial => { const name = names[stateIndex++]; state[name] = initial; return [initial, value => { state[name] = value; }]; },
    useRef: current => ({ current }), useCallback: fn => fn, useEffect: fn => effects.push(fn),
    setInterval: fn => { const id = ++timerId; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    setTimeout() {}, fetch: (...args) => fetcher(...args),
  });
  assert.equal(effects.length, 1);
  return {
    state, intervals, api: module.exports,
    set fetch(fn) { fetcher = fn; },
    async mount() { cleanup = effects[0](); await settle(); }, unmount() { cleanup?.(); },
  };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
for (const status of ['done', 'failed', 'interrupted', 'backing_up', 'recreating']) {
  await test(`reload retains persisted ${status} message`, async () => {
    const message = 'FORCED-STOP WARNING: owner lease may remain';
    const h = harness({ status, error: message }); await h.mount();
    assert.equal(['failed', 'interrupted'].includes(status) ? h.state.error : h.state.warning, message);
    assert.equal(h.intervals.size, ['backing_up', 'recreating'].includes(status) ? 1 : 0);
    h.unmount(); assert.equal(h.intervals.size, 0);
  });
}
for (const status of ['failed', 'interrupted']) {
  await test(`reload shows fallback for ${status} without a message`, async () => {
    const h = harness({ status, error: null }); await h.mount();
    assert.equal(h.state.error, 'Recreate failed'); h.unmount();
  });
  await test(`poll retains ${status} message just like reload`, async () => {
    const h = harness({ status: 'recreating', error: null }); await h.mount();
    h.fetch = async () => ({ ok: true, json: async () => ({ recreate: { status, error: 'FORCED-STOP WARNING' } }) });
    await [...h.intervals.values()][0]();
    assert.equal(h.state.error, 'FORCED-STOP WARNING'); assert.equal(h.intervals.size, 0); h.unmount();
  });
}
await test('unmounted discovery cannot restore a stale failure message', async () => {
  const h = harness(null); let resolve;
  h.fetch = () => new Promise(yes => { resolve = yes; });
  await h.mount(); h.unmount();
  resolve({ ok: true, json: async () => ({ recreate: { status: 'failed', error: 'stale message' } }) });
  await settle(); assert.equal(h.state.error, ''); assert.equal(h.state.warning, null);
});
console.log(`\n${passed} passed`);
