#!/usr/bin/env node
/** NET-1e: real dialog and lifecycle client, mocked hooks/fetch, no browser/network/Docker. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, dependencies, globals) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { module, exports: module.exports, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; }, console, ...globals });
  return module.exports;
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function harness() {
  const hooks = []; const effects = []; let index = 0; const timers = new Map(); let timerId = 0;
  let complete = 0, closed = 0, started = 0, hold = false, release, job = { id: 73, status: 'backing_up', backupPercent: 42 }, readError = false;
  const calls = [];
  const react = {
    useState: initial => { const i = index++; if (!(i in hooks)) hooks[i] = initial;
      return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef: initial => { const i = index++; return hooks[i] ??= { current: initial }; },
    useEffect: (fn, deps) => { const i = index++; if (!hooks[i]) { hooks[i] = { deps }; effects.push(() => { hooks[i].cleanup = fn(); }); } },
  };
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (!body.ports) return { status: 409, ok: false, json: async () => ({ code: 'ports_differ', setting: 'local' }) };
      if (hold) await new Promise(resolve => { release = resolve; });
      return { status: body.ports === 'move' ? 202 : 200, ok: true, json: async () => body.ports === 'move' ? { started: true, id: 73 } : { status: 'running' } };
    }
    if (readError) throw new Error('Status read failed');
    return { ok: true, json: async () => ({ recreate: job }) };
  };
  const globals = { fetch, AbortController, setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) };
  const client = load('lib/agent-start.ts', {}, globals);
  const initial = await client.requestAgentLifecycle('agent_fixture', 'start', new AbortController().signal);
  assert.equal(initial.kind, 'ports_differ');
  const ui = { Modal: function Modal() {}, Button: function Button() {} };
  const { AgentStartDialog } = load('app/components/ui/AgentStartDialog.tsx', { react, 'react/jsx-runtime': require('react/jsx-runtime'),
    './Modal': { Modal: ui.Modal }, './Button': { Button: ui.Button }, '@/lib/agent-start': client }, globals);
  function render(hostIp = '0.0.0.0') {
    index = 0; const nodes = [];
    const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return;
      nodes.push(node); walk(node.props?.children); };
    walk(AgentStartDialog({ prompt: { agentId: 'agent_fixture', name: 'Example', hostIp, setting: initial.setting },
      onComplete: () => complete++, onClose: () => closed++, onStarted: () => started++ }));
    effects.splice(0).forEach(fn => fn()); return nodes;
  }
  const button = label => render().find(n => n.type === ui.Button && n.props.children === label);
  return { render, button, calls, ui, client, counts: () => ({ complete, closed, started }),
    hold: () => { hold = true; }, release: () => { hold = false; release(); },
    job: value => { job = value; }, failRead: value => { readError = value; },
    tick: async () => { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); await flush(); },
    dispose: () => hooks.forEach(h => h?.cleanup?.()), timers };
}
let h = await harness();
assert.equal(h.render().find(n => n.type === h.ui.Modal).props.title, 'Start Example');
assert.ok(h.render().some(n => n.props?.href === '/remote-access' && n.props.className === 'ui-link'));
assert.equal(h.calls.length, 1, '409 and opening the dialog never mutate again');
h.button('Cancel').props.onClick(); assert.equal(h.counts().closed, 1); h.dispose();

for (const [choice, busyLabel, otherLabel] of [['Start as is', 'Starting…', 'Move and start'], ['Move and start', 'Moving…', 'Start as is']]) {
  h = await harness(); h.hold();
  const click = h.button(choice).props.onClick; click(); click(); await flush();
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 2, 'same-render duplicate click is guarded');
  assert.equal(h.button(busyLabel).props.loading, true);
  assert.equal(h.button(otherLabel).props.disabled, true);
  assert.equal(h.button('Cancel').props.disabled, true);
  h.render().find(n => n.type === h.ui.Modal).props.onClose(); assert.equal(h.counts().closed, 0);
  h.release(); await flush();
  const body = JSON.parse(h.calls[1].options.body);
  assert.deepEqual(body, { action: 'start', ports: choice === 'Start as is' ? 'as_is' : 'move' });
  if (choice === 'Start as is') {
    assert.equal(h.counts().complete, 1); assert.equal(h.calls.length, 2);
  } else {
    assert.equal(h.counts().complete, 0);
    assert.ok(h.render().some(n => n.props?.role === 'status' && n.props.children === 'Backing up… 42%'));
    h.failRead(true); await h.tick(); assert.ok(h.render().some(n => n.props?.role === 'alert' && n.props.children === 'Status read failed'));
    h.failRead(false); h.job({ id: 73, status: 'recreating' }); await h.tick();
    assert.ok(h.render().some(n => n.props?.role === 'status' && n.props.children === 'Recreating container…'));
    h.job({ id: 73, status: 'done' }); await h.tick(); assert.equal(h.counts().complete, 1);
    assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 2, 'polling never recreates again');
  }
  assert.equal(h.counts().started, 1); h.dispose();
}
for (const status of ['failed', 'interrupted', 'wrong-id']) {
  h = await harness(); h.job({ id: status === 'wrong-id' ? 99 : 73, status, error: 'Backup failed' });
  h.button('Move and start').props.onClick(); await flush();
  assert.equal(h.counts().complete, 0); assert.equal(h.button('Move and start').props.disabled, false);
  assert.ok(h.render().some(n => n.props?.role === 'alert'));
  assert.equal(h.timers.size, 0); h.dispose();
}
h = await harness(); h.button('Move and start').props.onClick(); await flush();
assert.equal(h.timers.size, 1); const signal = h.calls.at(-1).options.signal; h.dispose();
assert.equal(signal.aborted, true); assert.equal(h.timers.size, 0);
assert.equal(h.client.agentPortsLabel('127.0.0.1'), '127.0.0.1');
assert.equal(h.client.agentPortsLabel('::'), 'every interface');
const page = fs.readFileSync('app/agents/PageClient.tsx', 'utf8');
assert.ok(page.includes("result.kind === 'ports_differ'") && page.includes('<AgentStartDialog'));
assert.equal((page.match(/\{lifecycleFeedback\}/g) || []).length, 5, 'dialog available across desktop, mobile, and transient list errors/loading');
assert.equal((page.match(/title="Recreate to apply the Remote access setting"/g) || []).length, 2, 'card and detail warning');
assert.ok(page.includes('(!portsDiffer || agentRunning)'));
console.log('All agent start dialog tests passed (409, both choices, loading, duplicate clicks, polling, failures, cancellation, pills).');

// Execute the panel's actual RestartSection, then its actual shared dialog.
for (const choice of ['as_is', 'move']) {
  const ast = ts.createSourceFile('PageClient.tsx', page, ts.ScriptTarget.Latest, true);
  const section = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'RestartSection');
  assert.ok(section);
  const stores = { panel: [], dialog: [] }, effects = [], timers = new Map();
  let activeStore, cursor, completed = 0;
  const calls = [];
  const hooks = {
    useState(initial) { const store = activeStore, i = cursor++; if (!(i in store)) store[i] = initial;
      return [store[i], value => { store[i] = typeof value === 'function' ? value(store[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return activeStore[i] ??= { current: initial }; },
    useEffect(fn) { const store = activeStore, i = cursor++; if (!(i in store)) { store[i] = true; effects.push(() => { store[i] = { cleanup: fn() }; }); } },
  };
  const ui = { Button: function Button() {}, Modal: function Modal() {} };
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/restart')) return { status: 409, ok: false, json: async () => ({ code: 'ports_differ', setting: 'local' }) };
    if (options.method === 'POST') return { status: choice === 'move' ? 202 : 200, ok: true, json: async () => choice === 'move' ? { id: 73 } : { status: 'running' } };
    return { status: 200, ok: true, json: async () => ({ recreate: { id: 73, status: 'done' } }) };
  };
  const globals = { fetch, AbortController, setTimeout: fn => { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) };
  const client = load('lib/agent-start.ts', {}, globals);
  const { AgentStartDialog } = load('app/components/ui/AgentStartDialog.tsx', { react: hooks, 'react/jsx-runtime': require('react/jsx-runtime'),
    './Modal': { Modal: ui.Modal }, './Button': { Button: ui.Button }, '@/lib/agent-start': client }, globals);
  const module = { exports: {} };
  const code = ts.transpileModule(section.getText(ast) + '\nmodule.exports = { RestartSection };', { fileName: 'section.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, ...hooks, ...globals, ...ui, AgentStartDialog,
    SectionHeader: function SectionHeader() {}, RotateIcon: function RotateIcon() {}, require: name => { assert.equal(name, 'react/jsx-runtime'); return require(name); } });
  const render = (component, props, store) => {
    activeStore = stores[store]; cursor = 0; const nodes = [];
    const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; nodes.push(node); walk(node.props?.children); };
    walk(component(props)); effects.splice(0).forEach(fn => fn()); return nodes;
  };
  const props = { agentName: 'agent_fixture', displayName: 'Stopped fixture', hostIp: '0.0.0.0', agentBusy: false, onRestarted: () => completed++ };
  const panel = () => render(module.exports.RestartSection, props, 'panel');
  const restartButton = panel().find(n => n.type === ui.Button && n.props.children === 'Restart Container');
  assert.equal(restartButton.props.disabled, false);
  const pending = restartButton.props.onClick(); await restartButton.props.onClick(); await pending;
  assert.equal(calls.length, 1, 'panel double click sends one guarded restart');
  const dialogNode = panel().find(n => n.type === AgentStartDialog);
  assert.equal(dialogNode.props.prompt.agentId, 'agent_fixture'); assert.equal(dialogNode.props.prompt.name, 'Stopped fixture');
  assert.equal(panel().find(n => n.type === ui.Button).props.disabled, true);
  const dialog = () => render(AgentStartDialog, dialogNode.props, 'dialog');
  dialog().find(n => n.type === ui.Button && n.props.children === (choice === 'move' ? 'Move and start' : 'Start as is')).props.onClick();
  await flush();
  assert.equal(calls[1].url, '/api/agents/agent_fixture/lifecycle');
  assert.deepEqual(JSON.parse(calls[1].options.body), { action: 'start', ports: choice });
  assert.ok(completed > 0); assert.equal(panel().some(n => n.type === AgentStartDialog), false);
  console.log(`STOPPED_PANEL_RESTART ${choice} restartPosts=1 dialogTitle="Start Stopped fixture" choiceBody=${calls[1].options.body} completed=true`);
  for (const store of Object.values(stores)) for (const h of store) h?.cleanup?.();
}
