#!/usr/bin/env node
/**
 * Tests of the pure Subscriptions UI logic added with the Claude accordion: the row mapping
 * (state -> status line, tone and actions), the guided dialog's step for every login state, and
 * the safety of the pasted-code dialog (no client storage, no logging, the code dropped on send).
 *
 * Run: node scripts/test-subscription-claude-ui.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const copy = await import('../app/subscriptions/providers.ts');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok   ${name}`); };

const anthropic = copy.getProviderCopy('anthropic');
const chatgpt = copy.getProviderCopy('openai');
const formatDate = (iso) => `date(${iso})`;

await test('row: not-installed is "Not connected" with Connect only', () => {
  const view = copy.claudeRowView({ running: true, connected: false, error: null, claude: { state: 'not-installed' } }, anthropic, formatDate);
  assert.deepEqual(view, { status: 'Not connected', tone: 'neutral', action: 'connect', disconnect: false, account: false });
});

await test('row: signed-out is "Not connected" with Connect only', () => {
  const view = copy.claudeRowView({ running: true, connected: false, error: null, claude: { state: 'signed-out' } }, anthropic, formatDate);
  assert.deepEqual(view, { status: 'Not connected', tone: 'neutral', action: 'connect', disconnect: false, account: false });
});

await test('row: route-off is "Signed in, not in use" with Reconnect and Disconnect', () => {
  const view = copy.claudeRowView({ running: true, connected: false, error: null, claude: { state: 'route-off' } }, anthropic, formatDate);
  assert.deepEqual(view, { status: 'Signed in, not in use', tone: 'warning', action: 'reconnect', disconnect: true, account: true });
});

await test('row: connected shows the expiry and the account, Disconnect only', () => {
  const view = copy.claudeRowView(
    { running: true, connected: true, error: null, expiresAt: '2026-12-01T00:00:00.000Z', claude: { state: 'connected' } },
    anthropic,
    formatDate,
  );
  assert.deepEqual(view, {
    status: 'Connected until date(2026-12-01T00:00:00.000Z)',
    tone: 'success',
    action: 'none',
    disconnect: true,
    account: true,
  });
  const noExpiry = copy.claudeRowView({ running: true, connected: true, error: null, claude: { state: 'connected' } }, anthropic, formatDate);
  assert.equal(noExpiry.status, 'Connected');
});

await test('row: needs-reconnect is "Needs a new sign-in" with Reconnect and Disconnect', () => {
  const view = copy.claudeRowView({ running: true, connected: false, error: null, claude: { state: 'needs-reconnect' } }, anthropic, formatDate);
  assert.deepEqual(view, { status: 'Needs a new sign-in', tone: 'warning', action: 'reconnect', disconnect: true, account: false });
});

await test('row: a stopped agent says Stopped and offers the same disabled Connect as ChatGPT', () => {
  const view = copy.claudeRowView({ running: false, connected: true, error: null, claude: { state: 'connected' } }, anthropic, formatDate);
  assert.deepEqual(view, { status: 'Stopped', tone: 'neutral', action: 'connect', disconnect: false, account: false });
});

await test('row: the read error wins over the state, as on ChatGPT', () => {
  const view = copy.claudeRowView({ running: true, connected: false, error: 'Could not read', claude: { state: 'not-installed' } }, anthropic, formatDate);
  assert.deepEqual(view, { status: 'Error', tone: 'danger', action: 'connect', disconnect: false, account: false });
});

await test('row: an unknown or missing state is "Not connected", never invented', () => {
  for (const state of [undefined, null, 'something-new']) {
    const view = copy.claudeRowView({ running: true, connected: false, error: null, claude: state ? { state } : null }, anthropic, formatDate);
    assert.equal(view.status, 'Not connected');
    assert.equal(view.action, 'connect');
    assert.equal(view.disconnect, false);
  }
});

await test('dialog step: every login state maps to the step that shows it', () => {
  const expected = {
    starting: 'starting',
    installing: 'installing',
    waiting: 'waiting',
    verifying: 'verifying',
    connecting: 'connecting',
    connected: 'connected',
    failed: 'failed',
    expired: 'failed',
    cancelled: 'failed',
  };
  for (const [state, step] of Object.entries(expected)) {
    assert.equal(copy.linkCodeStep(state), step, state);
  }
  assert.equal(copy.linkCodeStep(null), 'failed');
  assert.equal(copy.linkCodeStep('something-new'), 'failed');
});

await test('dialog copy: the first install and the wrong-code answer are exact', () => {
  assert.equal(anthropic.linkCode.installing, 'Installing Claude Code in the agent… This takes about a minute, only the first time.');
  assert.equal(anthropic.linkCode.invalidCode, "This doesn't look like a code from Anthropic. Copy it again.");
  assert.equal(anthropic.linkCode.checking, 'Checking…');
  assert.equal(anthropic.linkCode.startAgain, 'Start again');
  assert.equal(anthropic.linkCode.connectedHint, 'Choose a Claude model in the agent panel.');
  assert.equal(chatgpt.linkCode, undefined);
});

// ---- the code never leaves the dialog --------------------------------------------------

const modal = readFileSync(new URL('../app/subscriptions/ClaudeConnectModal.tsx', import.meta.url), 'utf8');

await test('dialog: built only from the shared UI primitives', () => {
  assert.match(modal, /from '@\/app\/components\/ui'/);
  for (const primitive of ['Button', 'Input', 'LoadingSpinner', 'Modal']) {
    assert.match(modal, new RegExp(`\\b${primitive}\\b`), primitive);
  }
});

await test('dialog: the pasted code is not persisted, logged or put in a URL', () => {
  const codeOnly = modal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB/.test(codeOnly), false);
  assert.equal(/console\./.test(codeOnly), false);
  assert.equal(/searchParams|location\.(?:href|search)|history\./.test(codeOnly), false);
  assert.equal(/showToast|toast\(/i.test(codeOnly), false);
});

await test('dialog: the input is not autocompleted or spell-checked, and the code is cleared before sending', () => {
  assert.match(modal, /autoComplete="off"/);
  assert.match(modal, /spellCheck=\{false\}/);
  const submit = modal.indexOf('const submit = async () => {');
  const clear = modal.indexOf("setCode('')", submit);
  const send = modal.indexOf('/code', submit);
  assert.ok(submit !== -1 && clear !== -1 && send !== -1, 'submit body found');
  assert.ok(clear < send, 'the input is cleared before the request');
});

await test('dialog: the sign-in page opens in a new tab without a window handle', () => {
  assert.match(modal, /window\.open\(login\.url, '_blank', 'noopener,noreferrer'\)/);
});

await test('dialog: closing while the job is active cancels it', () => {
  assert.match(modal, /if \(active \|\| starting\) void cancel\(\);/);
  assert.match(modal, /method: 'DELETE'/);
});

await test('dialog: while the code is being submitted, the Cancel and sign-in buttons are disabled', () => {
  assert.match(modal, /disabled=\{!login\.url \|\| submitting\}/);
  assert.match(modal, /disabled=\{cancelling \|\| submitting\}/);
});

await test('dialog: the first start POST is abortable with a 20 s timeout, and Close cancels its job', () => {
  assert.match(modal, /const startRef = useRef<AbortController \| null>\(null\);/);
  assert.match(modal, /const deadline = setTimeout\(\(\) => controller\.abort\(\), 20_000\);/);
  assert.match(modal, /signal: controller\.signal/);
  assert.match(modal, /if \(starting\) \{\s*startRef\.current\?\.abort\(\);/);
  assert.match(modal, /void fetch\(`\$\{loginPath\}\?agentId=\$\{encodeURIComponent\(agentId\)\}`, \{ method: 'DELETE' \}\)/);
});

// ---- the code submit wins over a poll already in flight --------------------------------

const tree = ts.createSourceFile('ClaudeConnectModal.tsx', modal, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = tree.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'ClaudeConnectModal');
const pollEffect = component.body.statements.find((n) =>
  ts.isExpressionStatement(n) && n.expression.expression?.getText(tree) === 'useEffect' && n.getText(tree).includes('pollRef.current = controller'));
const submitDecl = component.body.statements.find((n) =>
  ts.isVariableStatement(n) && n.declarationList.declarations.some((d) => d.name.getText(tree) === 'submit'));

await test('dialog: a poll in flight when the code is submitted cannot put the view back to waiting', async () => {
  assert.ok(pollEffect && submitDecl, 'the poll effect and the submit function are found');
  const source = `
    const POLL_MS = 2000;
    const pollRef = { current: null };
    const stateSeqRef = { current: 0 };
    const cleanup = (${pollEffect.expression.arguments[0].getText(tree)})();
    const submit = ${submitDecl.declarationList.declarations[0].initializer.getText(tree)};
    module.exports = { cleanup, submit };
  `;
  const applied = [];
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    JSON,
    AbortController,
    encodeURIComponent,
    active: true,
    agentId: 'agent_fixture',
    loginPath: '/api/subscriptions/anthropic/login',
    code: 'fixture-code',
    text: { checking: 'Checking…', invalidCode: 'invalid', failed: 'failed' },
    setCode() {},
    setCodeError() {},
    setSubmitting() {},
    setLost() {},
    setLogin(login) { applied.push(login.state); },
    fetch(url, opts) {
      return new Promise((resolve, reject) => { requests.push({ url, opts, resolve, reject }); });
    },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  sandbox.module.exports = sandbox.exports;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, sandbox);
  const { cleanup, submit } = sandbox.module.exports;
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  // Start the poll: the effect schedules one tick.
  const timer = [...timers.values()][0];
  assert.ok(timer, 'the poll tick is scheduled');
  timer.fn();
  await flush();
  assert.equal(requests.length, 1, 'the poll request is in flight');
  const poll = requests[0];

  // Submit the code while the poll is still pending; its answer arrives first.
  const sending = submit();
  await flush();
  assert.equal(requests.length, 2, 'the code POST is in flight');
  requests[1].resolve({ ok: true, json: async () => ({ login: { state: 'verifying' } }) });
  await sending;
  assert.deepEqual(applied, ['verifying']);

  // The older poll answer lands late: it must be ignored.
  poll.resolve({ ok: true, json: async () => ({ login: { state: 'waiting' } }) });
  await flush();
  assert.deepEqual(applied, ['verifying'], 'the stale waiting answer is dropped');
  cleanup();
});

// ---- page rows: an open dialog makes the row busy ---------------------------------------

const page = readFileSync(new URL('../app/subscriptions/PageClient.tsx', import.meta.url), 'utf8');

await test('page: the open connect dialog is part of the row busy state, so Disconnect waits', () => {
  assert.match(page, /const busy = !!running \|\| row\.loading \|\| !!connecting;/);
  assert.match(page, /connecting=\{!!connectAgent && connectAgent\.providerId === provider\.id && connectAgent\.agentId === a\.agentId\}/);
});

await test('page: the optimistic disconnect job of a Claude row is claude-logout', () => {
  assert.match(page, /const kind: Job\['kind'\] = provider\.loginKind === 'link-code' \? 'claude-logout' : 'logout';/);
});

console.log(`\n${passed} passed`);
