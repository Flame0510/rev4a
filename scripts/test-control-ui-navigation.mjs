#!/usr/bin/env node
/** Native automation navigation keeps browser authentication; no Docker, HTTP or account writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, mocks = {}, extra = {}) {
  const full = path.join(root, file);
  const source = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const context = { exports: {}, URL, URLSearchParams, Date, console, require: (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    throw new Error(`Unexpected dependency: ${id}`);
  }, ...extra };
  vm.runInNewContext(source, context, { filename: full });
  return context.exports;
}
const ids = load('lib/cron-ids.ts');
const navigation = load('lib/control-ui-navigation.ts', { './cron-ids': ids });
const job = '8d10c9bf-231a-41af-a01f-bdbb2ff6a3f1';
const tokenLink = 'http://localhost:4550/#token=fixture%2B%2F%3D'; // secret-ok: synthetic offline fixture
const oneTime = 'https://example.test:4550/prefix/?theme=dark#bootstrapToken=fixture%2B%2F%3D&gatewayUrl=wss%3A%2F%2Fexample.test%3A4550';
let passed = 0;
async function test(name, fn) {
  await fn(); passed++; console.log(`ok   ${name}`);
}

await test('account adoption notice applies only to evaluated legacy upgrade transitions', () => {
  for (const from of ['2026.9.3', '2026.9.9']) {
    assert.equal(navigation.needsInferenceAccountAdoptionNotice(from, '2026.10.10'), true);
  }
  for (const [from, to] of [[null, '2026.10.10'], ['2026.10.10', '2026.10.10'],
    ['2026.9.9', '2026.10.11'], ['2026.9.9', null], ['2026.8.1', '2026.10.10']]) {
    assert.equal(navigation.needsInferenceAccountAdoptionNotice(from, to), false);
  }
});

await test('no job preserves existing root behavior byte for byte', () => {
  assert.equal(navigation.controlUiAutomationUrl(tokenLink), tokenLink);
  assert.equal(navigation.controlUiAutomationUrl(oneTime, null), oneTime);
  assert.equal(navigation.controlUiOpenPath('agent_123'), '/api/agents/agent_123/open-control-ui');
});
await test('automation navigation preserves host, port, base path, query and auth fragments', () => {
  for (const base of [tokenLink, oneTime, 'http://[::1]:4550/nested/base?theme=dark&job=old#token=fixture%2F']) {
    const original = new URL(base);
    const destination = new URL(navigation.controlUiAutomationUrl(base, job));
    assert.equal(destination.origin, original.origin);
    assert.equal(destination.pathname, original.pathname.replace(/\/+$/, '') + '/automations');
    assert.equal(destination.searchParams.get('job'), job);
    assert.equal(destination.searchParams.get('theme'), original.searchParams.get('theme'));
    assert.equal(destination.hash, original.hash);
  }
});
await test('invalid job values cannot become paths, CLI args, external redirects or fragment content', () => {
  for (const bad of ['', '../evil', 'https://evil.test', '//evil.test', '?token=bad', '#token=bad', '--help', 'x\ny', 'a'.repeat(129)]) {
    assert.throws(() => navigation.controlUiAutomationUrl(tokenLink, bad), /Invalid automation job id/);
    assert.throws(() => navigation.controlUiOpenPath('agent_123', bad), /Invalid automation job id/);
  }
  assert.throws(() => navigation.controlUiAutomationUrl('invalid secret URL', job), /Invalid Control UI link/);
});
await test('the browser receives only the authenticated Rev4a navigation URL', () => {
  const url = navigation.controlUiOpenPath('agent_123', job);
  assert.equal(url, `/api/agents/agent_123/open-control-ui?job=${job}`);
  assert.ok(!url.includes('token') && !url.includes('gatewayUrl'));
});
await test('the browser agent-ID check matches the existing server ID validator', () => {
  const server = load('lib/container.ts', { child_process: {} });
  for (const value of ['main', 'agent_123', 'a.b-c_d', 'a'.repeat(64), '', 'a'.repeat(65), '../main', 'x y', '-x', null]) {
    assert.equal(navigation.isControlUiAgentId(value), server.isValidAgentId(value), String(value));
  }
});
await test('guidance matches only the reproduced missing-inference-account refusal', () => {
  const actual = 'Automation has no recorded inference account. Explicitly select its account with a model@profile update before running it.';
  assert.equal(navigation.isMissingInferenceAccountError(actual), true);
  assert.equal(navigation.isMissingInferenceAccountError('Error: ' + actual), true);
  for (const unrelated of [null, {}, 'Insufficient Balance', 'Delivery Account ID is missing', 'Automation inference account was replaced.',
    'The user mentioned: ' + actual, 'Automation has no recorded inference accountX', 'No stored profile']) {
    assert.equal(navigation.isMissingInferenceAccountError(unrelated), false, String(unrelated));
  }
});

class Reply {
  constructor(body, options = {}) { this.body = body; this.status = options.status ?? 200; this.headers = options.headers ?? {}; }
}
function routeFixture(base = oneTime, options = {}) {
  const calls = [];
  const module = load('app/api/agents/[id]/open-control-ui/route.ts', {
    'next/server': { NextResponse: Reply }, '@/lib/rev4a-auth': { requireAuthJWT: async () => options.denied ?? null },
    '@/lib/agent-readiness': { probeGateway: async () => 'ready' }, '@/lib/gateway-state': { gatewayState: () => 'ready', blocksOpen: () => false },
    '@/lib/docker-socket': { dockerFetch: async () => { calls.push('inspect'); return {}; } },
    '@/lib/agent-devices': {
      hostnameFromHostHeader: (host) => host ? 'localhost' : null,
      findAgentContainer: async (id) => { calls.push(`find:${id}`); return options.agent === undefined ? { name: 'legacy-container-name', running: true, controlPort: '4550' } : options.agent; },
      resolveControlUiUrl: async () => { calls.push('native-link'); return { url: base, kind: 'one-time' }; },
    }, '@/lib/cron-ids': ids, '@/lib/control-ui-navigation': navigation,
  });
  const request = (query = '') => ({ url: `http://localhost:3740/api/agents/agent_123/open-control-ui${query}`, headers: { get: () => 'localhost:3740' } });
  return { calls, module, request, params: { params: Promise.resolve({ id: 'agent_123' }) } };
}
await test('actual route rejects malformed or repeated job before container lookup or native link issuance', async () => {
  for (const query of ['?job=', '?job=--help', '?job=a%2Fb', '?job=a&job=b', '?job=' + 'a'.repeat(129)]) {
    const f = routeFixture();
    const result = await f.module.GET(f.request(query), f.params);
    assert.equal(result.status, 400, query);
    assert.deepEqual(f.calls, []);
  }
});
await test('actual route keeps authentication first and root redirect unchanged', async () => {
  const denied = new Reply('denied', { status: 401 });
  const unauthorized = routeFixture(oneTime, { denied });
  assert.equal(await unauthorized.module.GET(unauthorized.request('?job=--help'), unauthorized.params), denied);
  assert.deepEqual(unauthorized.calls, []);
  const f = routeFixture();
  const result = await f.module.GET(f.request(), f.params);
  assert.equal(result.status, 302);
  assert.equal(result.headers.Location, oneTime);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
});
await test('actual route adds only a fixed native destination to both one-time and plain links', async () => {
  for (const base of [oneTime, tokenLink]) {
    const f = routeFixture(base);
    const result = await f.module.GET(f.request(`?job=${job}&redirect=https://evil.test`), f.params);
    assert.equal(result.status, 302);
    assert.equal(result.headers.Location, navigation.controlUiAutomationUrl(base, job));
    assert.equal(new URL(result.headers.Location).hash, new URL(base).hash);
    assert.equal(f.calls.filter((call) => call === 'native-link').length, 1);
  }
});
await test('SEC-9B: a loopback-only agent port answers a plain 409 with the tunnel, never a dead redirect (any caller of the route)', async () => {
  const cases = [
    // [HostIp, request host, expected 409?]
    ['127.0.0.1', 'srv.example.com', true], ['::1', '203.0.113.7', true], ['10.0.0.5', '10.0.0.5:3740', false], ['10.0.0.5', '203.0.113.7', true], ['', 'srv.example.com', false],
    ['0.0.0.0', 'srv.example.com', false], ['127.0.0.1', 'localhost:3740', false],
  ];
  for (const [hostIp, host, blocked] of cases) {
    const calls = [];
    const f = load('app/api/agents/[id]/open-control-ui/route.ts', {
      'next/server': { NextResponse: Reply }, '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
      '@/lib/agent-readiness': { probeGateway: async () => 'ready' }, '@/lib/gateway-state': { gatewayState: () => 'ready', blocksOpen: () => false },
      '@/lib/docker-socket': { dockerFetch: async () => ({ HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: hostIp, HostPort: '4550' }] } } }) },
      '@/lib/agent-devices': {
        hostnameFromHostHeader: (h) => String(h).replace(/:\d+$/, ''),
        findAgentContainer: async () => ({ name: 'c', running: true, controlPort: '4550' }),
        resolveControlUiUrl: async () => { calls.push('native-link'); return { url: oneTime, kind: 'one-time' }; },
      }, '@/lib/cron-ids': ids, '@/lib/control-ui-navigation': navigation,
    });
    const res = await f.GET({ url: 'http://x/api/agents/a/open-control-ui', headers: { get: () => host } }, { params: Promise.resolve({ id: 'a' }) });
    assert.equal(res.status === 409, blocked, `${hostIp} / ${host}`);
    if (blocked) {
      assert.match(String(res.body), /This agent's port is open only on the server itself\. Use an SSH tunnel: ssh -L /);
      assert.match(String(res.body), /\(then open http:\/\/localhost:4550\)/);
      assert.deepEqual(calls, [], 'no link issued');
    } else assert.equal(res.status, 302);
  }
});
await test('actual route does not issue links for missing or stopped agents', async () => {
  for (const [agent, status] of [[null, 404], [{ running: false }, 409]]) {
    const f = routeFixture(oneTime, { agent });
    assert.equal((await f.module.GET(f.request(`?job=${job}`), f.params)).status, status);
    assert.ok(!f.calls.includes('native-link'));
  }
});

await test('shared Open button navigates synchronously and respects job/disabled validation', () => {
  const source = fs.readFileSync(path.join(root, 'app/agents/BrowserAccessSection.tsx'), 'utf8');
  const parsed = ts.createSourceFile('BrowserAccessSection.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const button = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'OpenControlUiButton');
  const script = ts.transpileModule(button.getText(parsed) + '\nexports.ButtonUnderTest=OpenControlUiButton;', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const opened = [];
  const loopback = { protocol: 'http:', hostname: '127.0.0.1' };
  const context = { exports: {}, Button: () => {}, ControlUiExposureModal: () => {}, window: { open: (...args) => opened.push(args), location: loopback },
    useState: (value) => [value, () => {}], useEffect: () => {},
    controlUiOpenPath: navigation.controlUiOpenPath, controlUiExposesSession: navigation.controlUiExposesSession, controlUiPortLocalOnly: navigation.controlUiPortLocalOnly, isValidCronJobId: ids.isValidCronJobId,
    require: () => ({ jsx: (_type, props) => props, jsxs: (_type, props) => props, Fragment: 'fragment' }), };
  vm.runInNewContext(script, context);
  const buttonProps = context.exports.ButtonUnderTest({ agentId: 'agent_123', jobId: job }).children[0];
  buttonProps.onClick({ stopPropagation() {} });
  assert.deepEqual([...opened[0]], [`/api/agents/agent_123/open-control-ui?job=${job}`, '_blank', 'noopener']);
  for (const props of [{ agentId: 'agent_123', jobId: '--help' }, { agentId: 'agent_123', jobId: job, disabled: true }]) {
    const blocked = context.exports.ButtonUnderTest(props).children[0];
    assert.equal(blocked.disabled, true); blocked.onClick({ stopPropagation() {} });
  }
  assert.equal(opened.length, 1);
});

await test('cron collector preserves internal agentId and overwrites spoofed Rev4a identity with discovery', async () => {
  const upstream = { id: job, agentId: 'main', rev4aAgentId: 'spoofed-other-agent', name: 'fixture' };
  const execFile = (_cmd, _args, _options, callback) => callback(null, { stdout: 'agent_trusted\tlegacy-container-name\n', stderr: '' });
  const cron = load('lib/openclaw-cron.ts', {
    child_process: { execFile, execFileSync: () => { throw new Error('Mutation forbidden'); } }, util: { promisify },
    '@/lib/docker-exec': { dockerExecNoFail: async () => JSON.stringify({ jobs: [upstream] }), mapWithConcurrency: async (items, _limit, fn) => Promise.all(items.map(fn)) },
    '@/lib/gateway-cli': { gatewayCliArgv: (args) => args }, '@/lib/agent-names': {}, '@/lib/cron-ids': ids,
  });
  const result = await cron.listOpenClawCronJobs();
  assert.equal(result.jobs[0].agentId, 'main');
  assert.equal(result.jobs[0].containerName, 'legacy-container-name');
  assert.equal(result.jobs[0].rev4aAgentId, 'agent_trusted');
});

await test('guidance uses the latest run, so an old refusal is hidden after a successful adopted run', () => {
  const source = fs.readFileSync(path.join(root, 'app/crons/PageClient.tsx'), 'utf8');
  const parsed = ts.createSourceFile('CronsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const page = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'CronsPage');
  const declarations = page.body.statements.filter((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((d) => ['latestRun', 'needsInferenceAccount'].includes(d.name.getText(parsed))));
  const compiled = ts.transpileModule(declarations.map((d) => d.getText(parsed)).join('\n') + '\nresult.needs=needsInferenceAccount;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const error = 'Automation has no recorded inference account. Explicitly select its account with a model@profile update before running it.';
  for (const [runs, expected] of [
    [[{ ts: 1, status: 'error', error }], true],
    [[{ ts: 1, status: 'error', error }, { ts: 2, status: 'ok' }], false],
    [[{ ts: 2, status: 'error', error: 'Quota exceeded' }, { ts: 1, status: 'error', error }], false],
  ]) {
    const result = {};
    vm.runInNewContext(compiled, { runs, result, isMissingInferenceAccountError: navigation.isMissingInferenceAccountError });
    assert.equal(result.needs, expected);
  }
});

await test('a delayed old run body cannot attach account guidance to a newly selected job', async () => {
  const source = fs.readFileSync(path.join(root, 'app/crons/PageClient.tsx'), 'utf8');
  const parsed = ts.createSourceFile('CronsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const page = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'CronsPage');
  const effect = page.body.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(parsed) === 'useEffect'
    && node.getText(parsed).includes('const requestKey'));
  assert.ok(effect);
  const compiled = ts.transpileModule(effect.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let setup; let resolveOldBody; let count = 0;
  const oldBody = new Promise((resolve) => { resolveOldBody = resolve; });
  const state = {};
  const context = {
    useEffect: (fn) => { setup = fn; }, AbortController, encodeURIComponent,
    selectedJob: { id: 'first', containerName: 'container-a' }, latestRunRequest: { current: null }, runAbortRef: { current: null },
    setRuns: (value) => { state.runs = value; }, setRunsLoading: () => {}, setRunsError: () => {},
    apiFetch: async () => ++count === 1 ? { ok: true, json: () => oldBody }
      : { ok: true, json: async () => ({ entries: [{ jobId: 'second', status: 'ok', ts: 2 }] }) },
  };
  vm.runInNewContext(compiled, context);
  const cleanupFirst = setup();
  await new Promise((resolve) => setImmediate(resolve));
  const oldController = context.runAbortRef.current;
  cleanupFirst();
  assert.equal(oldController.signal.aborted, true);
  context.selectedJob = { id: 'second', containerName: 'container-b' };
  const cleanupSecond = setup();
  await new Promise((resolve) => setImmediate(resolve));
  resolveOldBody({ entries: [{ jobId: 'first', status: 'error', error: 'Automation has no recorded inference account.' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.runs[0].jobId, 'second');
  cleanupSecond();
});

console.log(`\n${passed} passed`);
