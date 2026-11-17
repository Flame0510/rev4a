#!/usr/bin/env node
/** BUG-23: real notice fixture, production code with mocked exec/fetch and deterministic timers. No live calls. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const parse = await import('../lib/subscription-claude-parse.ts');
const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };

// Verbatim stderr from Claude Code 2.1.326 on the blocked account, including the leading empty line.
const NOTICE = '\n[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.\n';
const EVENT = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1794671400 }, seven_day: { utilization: 1 } } } });
const EMAIL = 'fixture+terms@example.invalid';
const termsError = { email: EMAIL, code: 'terms-required', message: parse.CLAUDE_TERMS_MESSAGE };
const account = { email: EMAIL, plan: 'Pro', windows: parse.parseClaudeUsageEvent(EVENT), updatedAt: null };
const genericError = { email: EMAIL, message: 'Could not read the Claude usage limits.' };

function evaluate(code, globals = {}, dependencies = {}) {
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console, AbortController, encodeURIComponent, ...globals };
  sandbox.require = (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, sandbox);
  return { exports: module.exports, sandbox };
}
function tree(file) { return ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS); }
function functions(file, names) {
  const ast = tree(file);
  return names.map((name) => {
    const fn = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(fn, name);
    return fn.getText(ast);
  }).join('\n');
}
function callback(file, component, name) {
  const ast = tree(file);
  const fn = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === component);
  const variable = fn.body.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations]).find((d) => d.name.getText(ast) === name);
  assert.ok(variable, name);
  return variable.initializer.arguments[0].getText(ast);
}

await test('terms detector: verbatim notice, stream preface and case-insensitive alternatives', () => {
  for (const value of [NOTICE, `${EVENT}\n${NOTICE}`, '[action required] CONSUMER TERMS', '[ACTION REQUIRED] please REVIEW THE UPDATED TERMS']) assert.equal(parse.claudeTermsRequired(value), true);
  for (const value of [EVENT, '', null, undefined, 42, {}, ['[ACTION REQUIRED] Consumer Terms'], '[ACTION REQUIRED] Upgrade your client', 'Consumer Terms', 'auth expired', 'network error']) assert.equal(parse.claudeTermsRequired(value), false);
  assert.equal(parse.CLAUDE_TERMS_MESSAGE, 'Anthropic asks this account to accept its updated terms before Claude can answer. Sign in at claude.ai with this account and accept them.');
});
await test('usage parser: interleaved stderr lines preserve the event; fixed probe redirects stderr', () => {
  assert.deepEqual(parse.parseClaudeUsageEvent(`warning on stderr\n{"type":"system"}\n${EVENT}\nother stderr\n`), parse.parseClaudeUsageEvent(EVENT));
  assert.match(parse.CLAUDE_USAGE_PROBE, /--verbose 2>&1; true$/);
  assert.equal(/\$\{|\$\(|credentials/.test(parse.CLAUDE_USAGE_PROBE), false);
});
await test('shared probe: terms take priority, rate limits still parse, exec errors are nonfatal', async () => {
  let output = NOTICE;
  const calls = [];
  const { exports: runner } = evaluate(source('lib/claude-probe.ts'), {}, {
    '@/lib/subscription-claude-parse': parse,
    '@/lib/docker-exec': { dockerExec: async (...args) => { calls.push(args); if (output instanceof Error) throw output; return output; } },
  });
  for (const [text, expected] of [[NOTICE, { termsRequired: true }], [`${EVENT}\n${NOTICE}`, { termsRequired: true }], [EVENT, { windows: parse.parseClaudeUsageEvent(EVENT) }], ['', { failed: true }], ['[ACTION REQUIRED] Update client', { failed: true }], [new Error('private failure'), { failed: true }]]) {
    output = text;
    assert.deepEqual(plain(await runner.runClaudeProbe('container-fixture')), expected);
  }
  for (const args of calls) assert.deepEqual(plain(args), ['container-fixture', ['sh', '-c', parse.CLAUDE_USAGE_PROBE], { timeoutMs: 70_000 }]);
});
await test('usage: terms and ordinary failures cache per account; targeted refresh, TTL and concurrent dedup', async () => {
  let now = 1000;
  let calls = 0;
  let result = { termsRequired: true };
  let pending = null;
  const { exports: usage } = evaluate(source('lib/subscription-claude-usage.ts'), { Date: class extends Date { static now() { return now; } } }, {
    '@/lib/subscription-claude-parse': parse,
    '@/lib/claude-probe': { runClaudeProbe: async () => { calls++; return pending ?? result; } },
    '@/lib/subscriptions-parse': require('../lib/subscriptions-parse.js'),
    '@/lib/subscriptions': { subscriptionGeneration: () => 0 },
    '@/lib/subscription-claude': { claudePlanFor: () => 'Pro', findClaudeSources: async () => new Map([[EMAIL, 'c1'], ['other@example.invalid', 'c2']]) },
  });
  const read = (opts = {}) => usage.getClaudeUsage({ email: EMAIL, ...opts });
  assert.deepEqual(plain(await read()), { accounts: [], errors: [termsError] });
  await read(); assert.equal(calls, 1);
  result = { windows: account.windows };
  assert.equal((await read({ refresh: true })).accounts[0].email, EMAIL); assert.equal(calls, 2);
  result = { failed: true }; now += 180001;
  assert.deepEqual(plain((await read()).errors), [genericError]);
  await read(); assert.equal(calls, 3);
  await usage.getClaudeUsage({ email: 'other@example.invalid' }); assert.equal(calls, 4);
  let resolve;
  pending = new Promise((r) => { resolve = r; });
  const first = read({ refresh: true }); const second = read({ refresh: true });
  await flush(); assert.equal(calls, 5);
  resolve({ termsRequired: true }); await Promise.all([first, second]);
  assert.deepEqual(plain((await read()).errors), [termsError]); assert.equal(calls, 5);
});

function connectHarness(runProbe) {
  const jobs = new Map(); const order = []; const logs = [];
  const code = functions('lib/subscription-claude.ts', ['view', 'finish', 'verifyAndConnect', 'cancelClaudeLogin']) + '\nmodule.exports = {verifyAndConnect, cancelClaudeLogin, view};';
  const job = { agentId: 'fixture', container: 'container-fixture', state: 'verifying', email: null, plan: null, error: null, termsRequired: false, codeSubmitted: true, cancelled: false, child: null };
  jobs.set(job.agentId, job);
  const { exports: mod } = evaluate(code, {
    ACTIVE: ['starting', 'installing', 'waiting', 'verifying', 'connecting'], jobs: () => jobs,
    readClaudeRaw: async () => ({ installed: true, status: { loggedIn: true, authMethod: 'claude.ai', email: EMAIL, plan: 'Pro' } }),
    writeRouteOn: async () => { order.push('route'); }, ensureSandboxEnvInAgent: async () => { order.push('sandbox'); }, ensureLeanClaudeTools: async () => { order.push('lean'); },
    runClaudeProbe: async (container) => { assert.equal(container, job.container); order.push('probe'); return runProbe(); },
    dropClaudeCaches: () => { order.push('invalidate'); }, console: { warn: (line) => logs.push(line) },
    dockerExecNoFail: () => { throw new Error('cancelling a probe must not drive the login'); },
  });
  return { mod, job, order, logs };
}
await test('connect: after lean tools, terms flag + container-only log; unrelated failures still connect', async () => {
  for (const result of [{ termsRequired: true }, { failed: true }, { windows: account.windows }]) {
    const h = connectHarness(() => result);
    await h.mod.verifyAndConnect(h.job);
    assert.equal(h.job.state, 'connected'); assert.equal(h.job.termsRequired, 'termsRequired' in result);
    assert.deepEqual(h.order, ['route', 'sandbox', 'lean', 'probe', 'invalidate']);
    assert.deepEqual(h.logs, 'termsRequired' in result ? ['[claude] container-fixture: Anthropic asks this account to accept its updated terms'] : []);
    assert.equal(h.logs.join('').includes(EMAIL), false);
    assert.equal(h.mod.view({ ...h.job, termsRequired: undefined }).termsRequired, false);
  }
});
await test('connect: a cancel during the terms read is refused; the job still ends connected with the flag', async () => {
  let resolve;
  const h = connectHarness(() => new Promise((r) => { resolve = r; }));
  const done = h.mod.verifyAndConnect(h.job);
  await flush(); assert.deepEqual(h.order, ['route', 'sandbox', 'lean', 'probe']);
  assert.equal((await h.mod.cancelClaudeLogin('fixture')).state, 'connecting');
  assert.equal(h.job.cancelled, false);
  resolve({ termsRequired: true }); await done;
  assert.equal(h.job.state, 'connected'); assert.equal(h.job.termsRequired, true);
});
await test('connect: cancellation while configuration writes run keeps previous behaviour', async () => {
  const h = connectHarness(() => ({ failed: true }));
  assert.equal((await h.mod.cancelClaudeLogin('fixture')).state, 'verifying');
  assert.equal(h.job.cancelled, false);
});

await test('auto checks: explicit Open, visible 15-second checks, no overlap, absolute 5-minute limit, cleanup', async () => {
  let now = 0; let opened = null; let effect; let cleanup; let checks = 0;
  const intervals = new Map(); const deadlines = new Map(); const opens = []; let id = 0;
  const { exports: hook, sandbox } = evaluate(functions('app/subscriptions/usage.ts', ['useClaudeTermsAutoCheck']), {
    useState: () => [opened, (next) => { opened = next; }], useEffect: (fn) => { effect = fn; },
    Date: { now: () => now }, document: { visibilityState: 'visible' },
    window: { open: (...args) => opens.push(args) },
    setInterval: (fn, ms) => { const key = ++id; intervals.set(key, { fn, ms }); return key; }, clearInterval: (key) => intervals.delete(key),
    setTimeout: (fn, ms) => { const key = ++id; deadlines.set(key, { fn, at: now + ms }); return key; }, clearTimeout: (key) => deadlines.delete(key),
  });
  // A stable check and a stable busy reader, as the components pass them (useCallback over a ref).
  let busyNow = false; const isBusy = () => busyNow; const check = async () => { checks++; };
  let lastDeps = null;
  const render = (email = EMAIL) => {
    const open = hook.useClaudeTermsAutoCheck(email, check, isBusy);
    const deps = JSON.stringify([email, opened]);
    if (deps !== lastDeps) { cleanup?.(); cleanup = effect(); lastDeps = deps; }
    return open;
  };
  const open = render(); assert.equal(intervals.size, 0);
  open(); assert.deepEqual(opens, [['https://claude.ai', '_blank', 'noopener,noreferrer']]);
  render(); assert.equal([...intervals.values()][0].ms, 15_000);
  now = 15_000; [...intervals.values()][0].fn(); assert.equal(checks, 1);
  sandbox.document.visibilityState = 'hidden'; now = 20_000;
  [...intervals.values()][0].fn(); assert.equal(checks, 1);
  sandbox.document.visibilityState = 'visible';
  const timerBefore = [...intervals.keys()][0];
  busyNow = true; render(); now = 30_000; [...intervals.values()][0].fn(); assert.equal(checks, 1);
  busyNow = false; render();
  // A busy state that comes and goes must not restart the timer (two accounts would line up).
  assert.deepEqual([...intervals.keys()], [timerBefore]);
  render(); // Re-render after the request completes; deadline must not reset.
  assert.equal([...deadlines.values()][0].at, 300_000);
  now = 300_000; [...intervals.values()][0].fn(); assert.equal(checks, 1);
  [...deadlines.values()][0].fn(); assert.equal(intervals.size, 0);
  render('different@example.invalid'); assert.equal(intervals.size, 0);
  cleanup?.(); assert.equal(deadlines.size, 0);
});

await test('modal: account-scoped refresh, recover on matching success, preserve terms on inconclusive reads and ignore stale body', async () => {
  let login = { state: 'connected', email: EMAIL, termsRequired: true };
  let response = { accounts: [], errors: [termsError] }; let checking = false; let error = null; let abortBody = false;
  const requests = []; const ref = { current: null };
  const { exports: mod } = evaluate(`module.exports = ${callback('app/subscriptions/ClaudeConnectModal.tsx', 'ClaudeConnectModal', 'checkTerms')};`, {
    termsEmail: EMAIL, termsRef: ref, termsCheckingRef: { current: false }, setCheckingTerms: (x) => { checking = x; }, setTermsError: (x) => { error = x; }, setLogin: (fn) => { login = fn(login); },
    readJson: async (res) => { if (!res.ok) throw new Error('unavailable'); const json = await res.json(); if (abortBody) ref.current.abort(); return json; },
    fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => response }; },
  });
  await mod(); assert.equal(login.termsRequired, true); assert.equal(checking, false);
  assert.equal(requests[0].url, `/api/subscriptions/usage?provider=anthropic&refresh=1&email=${encodeURIComponent(EMAIL)}`);
  response = { accounts: [], errors: [genericError] }; await mod(); assert.equal(login.termsRequired, true);
  response = { accounts: [{ ...account, email: 'other@example.invalid' }], errors: [] }; await mod(); assert.equal(login.termsRequired, true);
  response = { accounts: [account], errors: [] }; await mod(); assert.equal(login.termsRequired, false);
  assert.equal(requests[0].opts.signal.aborted, true); assert.equal(error, null);
  login.termsRequired = true;
  // Abort before the async body read finishes, as when a dialog is closed during a check.
  abortBody = true;
  await mod(); assert.equal(login.termsRequired, true);
});

await test('usage block: targeted checks merge other accounts and retain known terms after transient errors', async () => {
  const other = { ...account, email: 'other@example.invalid' };
  let data = { accounts: [other], errors: [termsError] }; let response = { accounts: [], errors: [genericError] }; let refreshing = null;
  const requests = [];
  const { exports: load } = evaluate(`module.exports = ${callback('app/subscriptions/UsageBlock.tsx', 'UsageBlock', 'load')};`, {
    refreshingRef: { current: null }, abortRef: { current: null }, provider: { id: 'anthropic' }, DEFAULT_SUBSCRIPTION_PROVIDER: { id: 'openai' },
    setRefreshingKey: (x) => { refreshing = x; }, setLoading() {}, setFailed() {}, setData: (fn) => { data = fn(data); },
    fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => response }; },
  });
  await load(EMAIL); assert.deepEqual(plain(data.errors), [termsError]); assert.equal(refreshing, null);
  assert.equal(requests[0].url, `/api/subscriptions/usage?refresh=1&email=${encodeURIComponent(EMAIL)}&provider=anthropic`);
  response = { accounts: [account], errors: [] }; await load(EMAIL);
  assert.deepEqual(plain(data.errors), []); assert.equal(data.accounts.length, 2);
  assert.equal(requests[0].opts.signal.aborted, true);
});

await test('agent minute poll: reads account errors, preserves terms on failure, clears only on matching success', async () => {
  const states = []; let slot = 0; let effect; let cleanup;
  let response = { accounts: [], errors: [termsError] };
  const timers = new Map(); const requests = [];
  const { exports: hook } = evaluate(functions('app/agents/SubscriptionLine.tsx', ['useAccountUsage']) + '\nmodule.exports = useAccountUsage;', {
    useState: (value) => { const i = slot++; states[i] = value; return [value, (next) => { states[i] = next; }]; },
    useRef: () => ({ current: null }), useEffect: (fn) => { effect = fn; },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setInterval: (fn, ms) => { assert.equal(ms, 60_000); timers.set(1, fn); return 1; }, clearInterval: (key) => timers.delete(key),
    fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => response }; },
  });
  hook(EMAIL, 'anthropic'); cleanup = effect(); await flush();
  assert.equal(states[0], null); assert.equal(states[1], true);
  assert.equal(requests[0].url, `/api/subscriptions/usage?email=${encodeURIComponent(EMAIL)}&provider=anthropic`);
  response = { accounts: [], errors: [genericError] }; timers.get(1)(); await flush(); assert.equal(states[1], true);
  response = { accounts: [{ ...account, email: 'other@example.invalid' }], errors: [] }; timers.get(1)(); await flush(); assert.equal(states[1], true);
  response = { accounts: [account], errors: [] }; timers.get(1)(); await flush(); assert.equal(states[1], false); assert.equal(states[0].email, EMAIL);
  cleanup(); assert.equal(timers.size, 0); assert.equal(requests.at(-1).opts.signal.aborted, true);
});

console.log(`\n${passed} passed`);
