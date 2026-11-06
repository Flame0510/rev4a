#!/usr/bin/env node
/** Production BackupSection callbacks with controlled responses/hooks; no browser, timers or transport. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../app/agents/PageClient.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('PageClient.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const section = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'BackupSection');
assert.ok(section?.body);
const names = [
  'pollRef', 'abortRef', 'pollAbortRef', 'lifecycleRef', 'isCurrent', 'actionRef', 'beginAction', 'endAction', 'showToast', 'stopPolling',
  'loadBackups', 'startPolling', 'startRestorePolling', 'handleBackup', 'handleCancelBackup',
  'executeRestore', 'askDeleteBackup', 'handleDeleteBackup', 'handleResolveRestore',
];
const wanted = new Set(names);
const statements = section.body.statements.filter(node =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => wanted.has(declaration.name.getText(parsed)))
  || ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(parsed) === 'useEffect');
assert.equal(statements.length, names.length + 1, 'Every tested callback and its actual mount effect must be loaded');
const compiled = ts.transpileModule(statements.map(node => node.getText(parsed)).join('\n')
  + `\nmodule.exports = { ${names.join(', ')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

function harness() {
  const events = []; const calls = []; const intervals = new Map(); const timeouts = new Map();
  const state = {}; const module = { exports: {} };
  let effect; let cleanup; let nextTimer = 0;
  const defaultFetch = async (url, options) => {
    if (options?.method === 'POST') return response({ started: true, file: 'fixture.tar.gz' }, 202);
    if (options?.method === 'DELETE') return response({ success: true });
    if (url.endsWith('/restore')) return response({ restore: null });
    if (url.endsWith('/cold-backup')) return response({ backup: null });
    if (url.endsWith('/update')) return response({ update: null });
    return response({ backups: [] });
  };
  let fetcher = defaultFetch;
  const context = {
    module, AbortController, encodeURIComponent, agentName: 'fixture-container', agentId: 'agent_fixture', restoreConfirm: null,
    useRef: current => ({ current }), useCallback: fn => fn, useEffect: fn => { effect = fn; },
    fetch: (...args) => { calls.push(args); return fetcher(...args); },
    setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: fn => { const id = ++nextTimer; timeouts.set(id, fn); return id; },
    onStarted: kind => events.push({ kind: 'started', value: kind }),
    onChanged: () => events.push({ kind: 'changed' }),
  };
  for (const name of ['Backups', 'Loading', 'Backup', 'Restore', 'Busy', 'Toast', 'RestoreConfirm', 'ResolveConfirm', 'DeleteConfirm']) {
    context['set' + name] = value => {
      state[name] = value;
      if (name === 'RestoreConfirm') context.restoreConfirm = value;
      events.push({ kind: name, value });
    };
  }
  vm.runInNewContext(compiled, context);
  return {
    api: module.exports, state, events, calls, intervals, timeouts,
    set fetch(fn) { fetcher = fn; }, resetFetch() { fetcher = defaultFetch; },
    async mount() { cleanup = effect(); await settle(); },
    unmount() { cleanup?.(); cleanup = undefined; },
    confirmRestore() { context.restoreConfirm = 'fixture.tar.gz'; },
    resetEvents() { events.length = 0; calls.length = 0; },
  };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
const noLateWork = h => {
  assert.equal(h.events.length, 0, 'A stale completion changed state or notified its parent');
  assert.equal(h.intervals.size, 0, 'A stale completion started polling');
  assert.equal(h.timeouts.size, 0, 'A stale completion scheduled a toast');
};

await test('an older parsed backup list cannot replace a completed newer refresh', async () => {
  const h = harness(); await h.mount();
  const body = deferred(); let reads = 0;
  h.fetch = async () => ({ ok: true, json: () => ++reads === 1 ? body.promise : Promise.resolve({ backups: [{ name: 'newer-list' }] }) });
  const old = h.api.loadBackups(); await settle();
  await h.api.loadBackups();
  body.resolve({ backups: [{ name: 'stale-list' }] }); await old;
  assert.equal(h.state.Backups[0].name, 'newer-list');
  h.unmount();
});

await test('unmounted callbacks cannot start requests, state changes or polling', async () => {
  const h = harness(); await h.mount(); h.confirmRestore(); h.unmount(); h.resetEvents();
  await h.api.loadBackups(); await h.api.handleBackup(); await h.api.executeRestore();
  await h.api.handleCancelBackup(); await h.api.askDeleteBackup('fixture.tar.gz'); await h.api.handleDeleteBackup('fixture.tar.gz');
  h.api.startPolling(); h.api.startRestorePolling();
  noLateWork(h); assert.equal(h.calls.length, 0);
});

for (const action of ['handleBackup', 'executeRestore']) {
  await test(`${action}: accepted POST after unmount cannot revive polling`, async () => {
    const h = harness(); await h.mount(); h.confirmRestore(); const post = deferred();
    h.fetch = () => post.promise;
    const running = h.api[action](); h.unmount(); h.resetEvents();
    post.resolve(response({ started: true, file: 'fixture.tar.gz' }, 202)); await running;
    noLateWork(h);
  });
  await test(`${action}: StrictMode cleanup/remount does not admit an older accepted POST`, async () => {
    const h = harness(); await h.mount(); h.confirmRestore(); const post = deferred();
    h.fetch = () => post.promise;
    const running = h.api[action](); h.unmount(); h.resetFetch(); await h.mount(); h.resetEvents();
    post.resolve(response({ started: true, file: 'fixture.tar.gz' }, 202)); await running;
    noLateWork(h); assert.equal(h.state.Busy, null); h.unmount();
  });
  await test(`${action}: old refusal and network failure are silent after cleanup/remount`, async () => {
    for (const rejected of [false, true]) {
      const h = harness(); await h.mount(); h.confirmRestore(); const post = deferred();
      h.fetch = () => post.promise;
      const running = h.api[action](); h.unmount(); h.resetFetch(); await h.mount(); h.resetEvents();
      if (rejected) post.reject(new Error('old connection failed'));
      else post.resolve(response({ error: 'old refusal' }, 409));
      await running; noLateWork(h); h.unmount();
    }
  });
  await test(`${action}: current refusal still reports an error and releases its loading state`, async () => {
    const h = harness(); await h.mount(); h.confirmRestore();
    h.fetch = async () => response({ error: 'Current refusal' }, 409);
    await h.api[action]();
    assert.equal(h.state.Toast.msg, 'Current refusal'); assert.equal(h.state.Toast.type, 'error');
    assert.equal(h.state.Busy, null); assert.equal(h.intervals.size, 0); h.unmount();
  });
  await test(`${action}: current acceptance starts polling and cleanup removes it`, async () => {
    const h = harness(); await h.mount(); h.confirmRestore();
    await h.api[action]();
    assert.equal(h.intervals.size, 1); assert.equal(h.state.Busy, null);
    assert.equal(h.events.filter(event => event.kind === 'started').length, 1);
    h.unmount(); assert.equal(h.intervals.size, 0);
  });
}

await test('a pending old poll result cannot replace remounted state or schedule a success toast', async () => {
  const h = harness(); await h.mount(); const body = deferred();
  h.fetch = async () => ({ ok: true, json: () => body.promise });
  h.api.startRestorePolling(); const tick = [...h.intervals.values()][0](); await settle();
  h.unmount(); h.resetFetch(); await h.mount(); h.resetEvents();
  body.resolve({ restore: { status: 'done', file: 'old.tar.gz' } }); await tick;
  noLateWork(h); assert.equal(h.state.Restore, null); h.unmount();
});

await test('initial discovery from an older mount cannot take over a later mount', async () => {
  const h = harness(); const body = deferred();
  h.fetch = async url => url.endsWith('/restore') ? { ok: true, json: () => body.promise } : response({ backups: [] });
  await h.mount(); h.unmount(); h.resetFetch(); await h.mount(); h.resetEvents();
  body.resolve({ restore: { status: 'restoring', file: 'old.tar.gz' } }); await settle();
  noLateWork(h); assert.equal(h.state.Restore, null); h.unmount();
});

await test('delete confirmation lookup owns a loading key and cannot open a modal after cleanup', async () => {
  const h = harness(); await h.mount(); const lookup = deferred();
  h.fetch = () => lookup.promise;
  const running = h.api.askDeleteBackup('fixture.tar.gz');
  assert.equal(h.state.Busy.kind, 'checking-delete');
  h.unmount(); h.resetFetch(); await h.mount(); h.resetEvents();
  lookup.resolve(response({ update: null })); await running;
  noLateWork(h); assert.equal(h.state.DeleteConfirm, null); h.unmount();
});

const actions = ['handleBackup', 'handleCancelBackup', 'executeRestore', 'askDeleteBackup', 'handleDeleteBackup', 'handleResolveRestore'];
const invoke = (h, name) => {
  if (name === 'executeRestore') h.confirmRestore();
  return h.api[name](name === 'handleResolveRestore' ? 7 : 'fixture.tar.gz');
};
for (const owner of actions) {
  await test(`${owner}: duplicate and cross-action calls cannot bypass the synchronous claim`, async () => {
    const h = harness(); await h.mount(); h.resetEvents(); const pending = deferred();
    h.fetch = () => pending.promise;
    const running = invoke(h, owner);
    for (const contender of actions) await invoke(h, contender);
    assert.equal(h.calls.length, 1, 'Another request started before the original action completed');
    assert.ok(h.api.actionRef.current);
    pending.resolve(response({ error: 'Refused' }, 409)); await running;
    assert.equal(h.api.actionRef.current, null); assert.equal(h.state.Busy, null); h.unmount();
  });
  await test(`${owner}: current request failure releases the claim so a retry can start`, async () => {
    const h = harness(); await h.mount(); h.resetEvents();
    h.fetch = async () => { throw new Error('Connection failed'); };
    await invoke(h, owner);
    assert.equal(h.api.actionRef.current, null); assert.equal(h.state.Busy, null);
    const pending = deferred(); h.fetch = () => pending.promise;
    const retry = invoke(h, owner);
    assert.equal(h.calls.length, 2, 'A released action could not retry');
    assert.ok(h.api.actionRef.current);
    pending.resolve(response({ error: 'Retry refused' }, 409)); await retry;
    assert.equal(h.api.actionRef.current, null); h.unmount();
  });
}

for (const action of ['handleCancelBackup', 'askDeleteBackup', 'handleDeleteBackup']) {
  await test(`${action}: current success releases its claim and permits another action`, async () => {
    const h = harness(); await h.mount();
    await invoke(h, action);
    assert.equal(h.api.actionRef.current, null); assert.equal(h.state.Busy, null);
    const pending = deferred(); h.fetch = () => pending.promise;
    const next = h.api.handleBackup(); assert.ok(h.api.actionRef.current);
    pending.resolve(response({ error: 'Next refusal' }, 409)); await next;
    assert.equal(h.api.actionRef.current, null); h.unmount();
  });
}

await test('an older mount completion cannot release a newer mount action claim', async () => {
  const h = harness(); await h.mount(); const old = deferred(); h.fetch = () => old.promise;
  const first = h.api.handleBackup(); h.unmount(); h.resetFetch(); await h.mount(); h.resetEvents();
  const current = deferred(); h.fetch = () => current.promise;
  const second = h.api.handleCancelBackup(); const owner = h.api.actionRef.current;
  assert.ok(owner); assert.equal(h.state.Busy.kind, 'cancelling');
  old.resolve(response({ started: true, file: 'old.tar.gz' }, 202)); await first;
  assert.equal(h.api.actionRef.current, owner); assert.equal(h.state.Busy.kind, 'cancelling');
  await h.api.handleBackup(); assert.equal(h.calls.length, 1, 'Stale completion unlocked a competing action');
  current.resolve(response({ error: 'Current refusal' }, 409)); await second;
  assert.equal(h.api.actionRef.current, null); assert.equal(h.state.Busy, null); h.unmount();
});

await test('resolve uses the confirmed row ID, owns a loading key and publishes the returned outcome', async () => {
  const h = harness(); await h.mount(); h.resetEvents(); const pending = deferred();
  h.fetch = () => pending.promise;
  const request = h.api.handleResolveRestore(7);
  assert.equal(h.state.Busy.kind, 'resolving');
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.ok(JSON.stringify(call).includes('/restore/resolve')); assert.ok(JSON.stringify(call).includes('restoreId'));
  pending.resolve(response({ resolved: true, restore: { id: 7, status: 'interrupted', phase: 'manually_resolved' } }));
  // Backup reload is the next request, and uses its own abortable read.
  h.resetFetch(); await request;
  assert.equal(h.state.Restore.phase, 'manually_resolved'); assert.equal(h.state.Busy, null);
  assert.match(h.state.Toast.msg, /reservation released/); h.unmount();
});
await test('resolve completion after an agent change cannot replace the current restore', async () => {
  const h = harness(); await h.mount(); const pending = deferred(); h.fetch = () => pending.promise;
  const request = h.api.handleResolveRestore(7); h.unmount(); h.resetFetch(); await h.mount(); h.resetEvents();
  pending.resolve(response({ resolved: true, restore: { id: 7, status: 'interrupted' } }));
  await request; noLateWork(h); h.unmount();
});

await test('unresolved restore keeps backup actions locked and renders attention guidance', () => {
  const action = section.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(parsed) === 'actionsLocked'));
  const code = ts.transpileModule(action.getText(parsed) + ';this.locked=actionsLocked;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { running: false, restoring: false, restore: { status: 'unresolved' }, busy: null, agentBusy: false };
  vm.runInNewContext(code, context); assert.equal(context.locked, true);
  let attention;
  const visit = node => { if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && node.right.getText(parsed).includes('Restore needs attention:')) attention = node.left; ts.forEachChild(node, visit); };
  visit(section); assert.ok(attention); assert.equal(vm.runInNewContext(attention.getText(parsed), context), true);
});

console.log(`\n${passed} passed (offline production BackupSection callbacks)`);
