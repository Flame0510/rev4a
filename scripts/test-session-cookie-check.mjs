#!/usr/bin/env node
/** INST-4: execute the cookie check and both real submit handlers entirely offline. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const helperCode = compile(read('lib/session-cookie-check.ts'));

function helper(fetch) {
  const exports = {};
  vm.runInNewContext(helperCode, { exports, fetch });
  return exports;
}

function handlerSource(file, name) {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `Missing handler ${name}`);
  return compile(`${ts.isVariableDeclaration(found) ? 'const ' : ''}${found.getText(ast)}; exports.handler = ${name};`);
}

const loginCode = handlerSource('app/login/page.tsx', 'handleSubmit');
const wizardCode = handlerSource('app/wizard/PageClient.tsx', 'handleComplete');
const retryMessage = 'Could not verify your session. Check your connection and try again.';
const { sessionCookieMessage } = helper(() => assert.fail('Pure decision must not fetch'));
const httpMessage = sessionCookieMessage(401, 'http:');
const httpsMessage = sessionCookieMessage(401, 'https:');

assert.equal(httpMessage, 'Signed in, but your browser refused the session cookie. Check that cookies are allowed for this site, or serve Rev4a over HTTPS.');
assert.doesNotMatch(httpMessage, /REV4A_FORCE_INSECURE_COOKIE/);
assert.match(httpsMessage, /cookies are allowed for this site/);
assert.doesNotMatch(httpsMessage, /REV4A_FORCE_INSECURE_COOKIE/);
for (const protocol of ['http:', 'https:']) {
  assert.equal(sessionCookieMessage(200, protocol), null);
  assert.equal(sessionCookieMessage(500, protocol), retryMessage);
  assert.equal(sessionCookieMessage(403, protocol), retryMessage);
}

function harness(kind, protocol = 'http:') {
  const state = { error: '', loading: false, action: null, routes: [], calls: [], wizardReads: 0, completions: 0 };
  const abortRef = { current: null };
  const busyRef = { current: false };
  let checkResponse = async () => ({ status: 200 });
  let loginStatus = 200;
  let wizardDone = true;
  let completionSaved = true;
  const fetch = async (url, options) => {
    state.calls.push({ url, options });
    if (url === '/api/auth/check') return checkResponse(options);
    assert.equal(url, '/api/auth/login');
    return { ok: loginStatus === 200, status: loginStatus, json: async () => ({ error: 'Invalid password' }) };
  };
  const exports = {};
  vm.runInNewContext(kind === 'login' ? loginCode : wizardCode, {
    exports, fetch, AbortController, window: { location: { protocol } },
    checkSessionCookie: helper(fetch).checkSessionCookie,
    password: 'fixture-password', locked: false, submittingRef: busyRef, submitAbortRef: abortRef,
    actionRef: busyRef, completionAbortRef: abortRef,
    setLoading: value => { state.loading = value; },
    setError: value => { state.error = value; },
    setCompletionError: value => { state.error = value; },
    setAction: value => { state.action = value; },
    router: { replace: route => state.routes.push(route), push: route => state.routes.push(route) },
    isWizardComplete: async () => { state.wizardReads++; return wizardDone; },
    completeAll: async () => { state.completions++; return completionSaved; },
  });
  return {
    state, abortRef, busyRef,
    submit: () => exports.handler({ preventDefault() {} }),
    set check(fn) { checkResponse = fn; },
    set loginStatus(value) { loginStatus = value; },
    set wizardDone(value) { wizardDone = value; },
    set completionSaved(value) { completionSaved = value; },
  };
}

let cases = 0;
for (const kind of ['login', 'wizard']) {
  for (const protocol of ['http:', 'https:']) {
    for (const outcome of ['ok', 'missing', 'network', 'server']) {
      const h = harness(kind, protocol);
      h.check = async () => {
        if (outcome === 'network') throw new TypeError('Offline');
        return { status: outcome === 'ok' ? 200 : outcome === 'missing' ? 401 : 503 };
      };
      await h.submit();
      assert.deepEqual(h.state.routes, outcome === 'ok' ? ['/'] : [], `${kind} ${protocol} ${outcome}`);
      assert.equal(h.state.error, outcome === 'ok' ? '' : outcome === 'missing' ? sessionCookieMessage(401, protocol) : retryMessage);
      assert.equal(h.state.loading, false, 'Login retry is enabled');
      assert.equal(h.state.action, null, 'Wizard retry and restart are enabled');
      assert.equal(h.busyRef.current, false);
      const checks = h.state.calls.filter(call => call.url === '/api/auth/check');
      assert.equal(checks.length, 1);
      assert.equal(checks[0].options.method, 'GET');
      assert.equal(checks[0].options.credentials, 'same-origin');
      assert.equal(checks[0].options.cache, 'no-store');
      assert.equal(checks[0].options.signal, h.abortRef.current.signal);
      if (kind === 'login' && outcome !== 'ok') assert.equal(h.state.wizardReads, 0);
      cases++;
    }
  }

  // A pending check must hold navigation and refuse Enter/double-click submissions.
  const h = harness(kind);
  let finish;
  h.check = () => new Promise(resolve => { finish = resolve; });
  const pending = h.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.state.routes, []);
  assert.equal(h.busyRef.current, true);
  assert.equal(kind === 'login' ? h.state.loading : h.state.action, kind === 'login' ? true : 'complete');
  await h.submit();
  assert.equal(h.state.calls.filter(call => call.url === '/api/auth/check').length, 1);
  finish({ status: 401 });
  await pending;
  assert.equal(h.state.error, httpMessage);
  h.check = async () => ({ status: 200 });
  await h.submit();
  assert.deepEqual(h.state.routes, ['/'], 'Retry can succeed after the operator fixes transport');

  // Even a mock that ignores abort cannot navigate from a stale/unmounted page.
  const aborted = harness(kind);
  aborted.check = async () => { aborted.abortRef.current.abort(); return { status: 200 }; };
  await aborted.submit();
  assert.deepEqual(aborted.state.routes, []);
  assert.equal(aborted.state.error, '');
}

const invalid = harness('login');
invalid.loginStatus = 401;
await invalid.submit();
assert.equal(invalid.state.error, 'Invalid password');
assert.deepEqual(invalid.state.calls.map(call => call.url), ['/api/auth/login']);

const firstLogin = harness('login');
firstLogin.wizardDone = false;
await firstLogin.submit();
assert.deepEqual(firstLogin.state.routes, ['/wizard']);

const failedCompletion = harness('wizard');
failedCompletion.completionSaved = false;
await failedCompletion.submit();
assert.match(failedCompletion.state.error, /Could not finish the wizard/);
assert.deepEqual(failedCompletion.state.routes, []);
assert.deepEqual(failedCompletion.state.calls, []);
assert.equal(failedCompletion.state.action, null);

// Aborts are cancellation, never a cookie refusal or network error.
const controller = new AbortController();
controller.abort();
const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });
await assert.rejects(helper(async () => { throw abortError; }).checkSessionCookie('http:', controller.signal), { name: 'AbortError' });

console.log(`PASS: pure HTTP/HTTPS decisions, ${cases} handler outcomes, pending/retry/abort guards and failed completion (offline).`);
