/**
 * Tests of the Claude subscription helpers (lib/subscription-claude-parse.ts) and of the
 * `anthropic/` prefix in the model helpers (lib/subscriptions-parse.js).
 *
 * The fact-3 output of `claude auth login` is rebuilt here exactly as the CLI printed it
 * (verified live on 2026-11-14), including the OSC 8 hyperlink in both terminators.
 * Run: node scripts/test-subscription-claude.mjs
 */
import assert from 'node:assert/strict';
import fsx from 'node:fs';
import os from 'node:os';
import pathx from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { gatewayCliArgv } from '../lib/gateway-cli.ts';

const claude = await import('../lib/subscription-claude-parse.ts');
const require = createRequire(import.meta.url);
const { revertSubscriptionModel, isSubscriptionModel } = require('../lib/subscriptions-parse.js');
const sandboxEnv = require('../lib/claude-sandbox-env.js');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };
const testAsync = async (name, fn) => { await fn(); n++; console.log(`ok  ${name}`); };

/** Loads lib/agent-busy.ts with its dependencies stubbed, so its provider rules run for real. */
function loadAgentBusy({ openai, claude }) {
  const source = fsx.readFileSync(new URL('../lib/agent-busy.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console };
  sandbox.globalThis = sandbox;
  sandbox.__rev4aClaudeLoginActive = () => claude;
  const dependencies = {
    '@/lib/cold-backup': { isColdBackupRunning: async () => false },
    '@/lib/agent-update-state': { isUpdateActive: () => false },
    '@/lib/agent-recreate-state': { isRecreateActive: () => false },
    '@/lib/agent-restore-state': { isRestoreActive: () => false },
    '@/lib/agent-edit-state': { isEditActive: () => false },
    '@/lib/subscription-login': { isLoginActive: () => openai },
    '@/lib/subscription-actions': { actionBusyReason: () => null },
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

// ---- fact-3 output -------------------------------------------------------------------------

const URL_CLAUDE = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc123def456&response_type=code'
  + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback'
  + '&scope=user%3Aprofile+user%3Ainference&code_challenge=CHALLENGE123&code_challenge_method=S256&state=STATE456';

const BEL = '\x07';
const ST = '\x1b\\';

/** One OSC 8 hyperlink around its own visible text, as the CLI prints it. */
const hyperlink = (url, terminator) => `\x1b]8;;${url}${terminator}${url}\x1b]8;;${terminator}`;

/** The exact shape of the sign-in output: link, then the code prompt. */
const loginOutput = (terminator) => [
  'Opening browser to sign in…\r\n',
  `If the browser didn't open, visit: ${hyperlink(URL_CLAUDE, terminator)}\r\n`,
  'Paste code here if prompted > ',
].join('');

const acceptedUrl = (text, size) => {
  let acc = '';
  let first = null;
  for (let i = 0; i < text.length; i += size) {
    acc += text.slice(i, i + size);
    const p = claude.parseClaudeLogin(acc);
    if (p.url && !first) first = p.url;
  }
  return first;
};

test('login: the exact output with a BEL-terminated hyperlink gives Anthropic\'s link', () => {
  const p = claude.parseClaudeLogin(loginOutput(BEL));
  assert.equal(p.url, URL_CLAUDE);
  assert.equal(p.prompted, true);
  assert.equal(p.failed, null);
});

test('login: the same output with an ESC-backslash hyperlink', () => {
  const p = claude.parseClaudeLogin(loginOutput(ST));
  assert.equal(p.url, URL_CLAUDE);
  assert.equal(p.prompted, true);
  assert.equal(p.failed, null);
});

test('login: a hyperlink without visible text shows nothing', () => {
  const p = claude.parseClaudeLogin(`visit: \x1b]8;;${URL_CLAUDE}${BEL}\x1b]8;;${BEL}\r\nPaste code here if prompted > `);
  assert.equal(p.url, null);
  assert.equal(p.prompted, true);
});

test('login: split into many chunks, the first accepted link is the whole one, never a prefix', () => {
  for (const terminator of [BEL, ST]) {
    const text = loginOutput(terminator);
    for (const size of [1, 2, 3, 7, 50, 199, 497, 1000]) {
      assert.equal(acceptedUrl(text, size), URL_CLAUDE, `terminator ${JSON.stringify(terminator)} chunk ${size}`);
    }
  }
});

test('login: a link split across two chunks mid-URL is not accepted half-read', () => {
  const text = loginOutput(BEL);
  const cut = text.indexOf('&state=');
  const head = text.slice(0, cut);
  assert.equal(claude.parseClaudeLogin(head).url, null);
  assert.equal(claude.parseClaudeLogin(head + text.slice(cut)).url, URL_CLAUDE);
});

test('login: nothing yet', () => {
  assert.deepEqual(claude.parseClaudeLogin('Opening browser to sign in…\r\n'), { url: null, prompted: false, failed: null });
  assert.deepEqual(claude.parseClaudeLogin(''), { url: null, prompted: false, failed: null });
  assert.deepEqual(claude.parseClaudeLogin(null), { url: null, prompted: false, failed: null });
});

test('login: only claude.com/cai and claude.ai links are ever shown', () => {
  const base = '?code=true&client_id=x&response_type=code&state=y';
  for (const url of [
    `https://evil.example/oauth/authorize${base}`,
    `https://claude.com.evil.example/cai/oauth/authorize${base}`,
    `http://claude.com/cai/oauth/authorize${base}`,
    `https://evil.example/cai/oauth/authorize${base}`,
  ]) {
    assert.equal(claude.parseClaudeLogin(`${url}\r\nPaste code here if prompted > `).url, null, url);
  }
  // The alternate Anthropic host is accepted.
  const alt = `https://claude.ai/oauth/authorize${base}`;
  assert.equal(claude.parseClaudeLogin(`${alt}\r\n`).url, alt);
});

test('login: an oversized link is never shown', () => {
  const long = `https://claude.com/cai/oauth/authorize?state=${'a'.repeat(2100)}\r\n`;
  assert.equal(claude.parseClaudeLogin(long).url, null);
});

test('login: Anthropic\'s own failure sentence, trimmed, on its line only', () => {
  const text = loginOutput(BEL) + '\r\nLogin failed: That code wasn\'t accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\r\n';
  const p = claude.parseClaudeLogin(text);
  assert.equal(
    p.failed,
    "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.",
  );
  assert.equal(p.url, URL_CLAUDE);
  assert.equal(p.failed.length <= 300, true);
  // A second line is not glued to the sentence.
  assert.equal(claude.parseClaudeLogin('Login failed: nope\r\nand more\n').failed, 'nope');
  // A marker with nothing after it is not a failure.
  assert.equal(claude.parseClaudeLogin('Login failed:\r\n').failed, null);
});

test('login: a very long failure is capped at 300 characters', () => {
  const p = claude.parseClaudeLogin(`Login failed: ${'x'.repeat(400)}\r\n`);
  assert.equal(p.failed.length, 300);
});

test('login: an unterminated OSC leaves no control character in the failure sentence', () => {
  const p = claude.parseClaudeLogin('\x1b]8;;evil\r\nLogin failed: \x1b]8;;evil');
  assert.equal(p.failed, ']8;;evil');
  assert.equal(/[\u0000-\u001f\u007f]/.test(p.failed), false);
  const split = claude.parseClaudeLogin('Login failed: bad \x1b]8;;still-open');
  assert.equal(/[\u0000-\u001f\u007f]/.test(split.failed), false);
  assert.equal(split.failed, 'bad ]8;;still-open');
});

// ---- validClaudeCode -----------------------------------------------------------------------

test('code: a normal code is accepted and surrounding spaces are dropped', () => {
  assert.equal(claude.validClaudeCode('abc123DEF_-.~#xyz'), 'abc123DEF_-.~#xyz');
  assert.equal(claude.validClaudeCode('  abc123DEF  '), 'abc123DEF');
  assert.equal(claude.validClaudeCode('a'.repeat(512)), 'a'.repeat(512));
  assert.equal(claude.validClaudeCode('a'.repeat(8)), 'a'.repeat(8));
});

test('code: anything a second line or a shell could use is refused', () => {
  const bad = [
    'abc123\nXYZ', 'abc123\rXYZ', 'abc 123 XYZ', 'abc123\tXYZ', 'abc\u0000XYZ', 'abc123\u00e9XYZ',
    '\nabc123XYZ', 'abc123XYZ\n', 'abc123XYZ\r\n', 'a'.repeat(7), 'a'.repeat(513),
    42, {}, [], null, undefined, true, ['abc123XYZ'],
  ];
  for (const value of bad) assert.equal(claude.validClaudeCode(value), null, String(value));
});

test('code: the allowed punctuation is exactly the documented set', () => {
  assert.equal(claude.validClaudeCode('abc.def_ghi-jkl'), 'abc.def_ghi-jkl');
  assert.equal(claude.validClaudeCode('abc~def#ghi+jkl'), 'abc~def#ghi+jkl');
  assert.equal(claude.validClaudeCode('abc/def=ghi'), 'abc/def=ghi');
  for (const value of ['abc123$XYZ', 'abc123&XYZ', 'abc123;XYZ', 'abc123 XYZ', 'abc123,XYZ', 'abc123:XYZ', 'abc123@XYZ']) {
    assert.equal(claude.validClaudeCode(value), null, value);
  }
});

// ---- parseClaudeStatus ---------------------------------------------------------------------

const statusOf = (extra = {}) => ({
  loggedIn: true, authMethod: 'claude.ai', email: 'me@example.invalid', orgName: null, plan: 'Pro', expiresAt: null, ...extra,
});
const now = Date.parse('2026-11-14T12:00:00.000Z');

test('status: the logged-out answer of fact 2', () => {
  const loggedOut = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","analyticsDisabled":false,'
    + '"projectsDirectory":"/root/.claude/projects","configDirectory":"/root/.claude","loginExpiresAt":null}';
  assert.deepEqual(claude.parseClaudeStatus(loggedOut), {
    loggedIn: false, authMethod: 'none', email: null, orgName: null, plan: null, expiresAt: null,
  });
});

test('status: the signed-in answer keeps only the whitelisted fields', () => {
  const loggedIn = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    analyticsDisabled: false,
    projectsDirectory: '/root/.claude/projects',
    configDirectory: '/root/.claude',
    loginExpiresAt: '2026-12-11T06:00:17.212Z',
    email: 'me@example.invalid',
    orgId: 'ORG-SECRET',
    orgName: 'Example',
    subscriptionType: 'pro',
    storedClaudeAiLogin: true,
    planTier: 'pro',
    accessToken: 'ACCESS-SECRET',
  });
  const s = claude.parseClaudeStatus(loggedIn);
  assert.deepEqual(s, {
    loggedIn: true,
    authMethod: 'claude.ai',
    email: 'me@example.invalid',
    orgName: 'Example',
    plan: 'Pro',
    expiresAt: '2026-12-11T06:00:17.212Z',
  });
  assert.deepEqual(Object.keys(s).sort(), ['authMethod', 'email', 'expiresAt', 'loggedIn', 'orgName', 'plan']);
  const text = JSON.stringify(s);
  for (const secret of ['ACCESS-SECRET', 'ORG-SECRET', 'storedClaudeAiLogin', 'projectsDirectory']) {
    assert.equal(text.includes(secret), false, secret);
  }
  // JSON behind a warning line is still read.
  assert.equal(claude.parseClaudeStatus(`(node:1) ExperimentalWarning\n${loggedIn}\n`).plan, 'Pro');
});

test('status: plan falls back to planTier and is capitalised, unknown values are null', () => {
  assert.equal(claude.parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","planTier":"max"}').plan, 'Max');
  assert.equal(claude.parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro lite"}').plan, 'Pro Lite');
  assert.equal(claude.parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"<script>"}').plan, null);
  // An empty or unusable subscriptionType falls back to planTier.
  assert.equal(
    claude.parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"","planTier":"max"}').plan,
    'Max',
  );
  assert.equal(
    claude.parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"<script>","planTier":"pro"}').plan,
    'Pro',
  );
  assert.equal(
    claude.parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":null,"planTier":"max"}').plan,
    'Max',
  );
  // A usable subscriptionType still wins over planTier.
  assert.equal(
    claude.parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","planTier":"max"}').plan,
    'Pro',
  );
  // No expiry reported is not an error.
  assert.equal(claude.parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai"}').expiresAt, null);
});

test('status: non-JSON gives null', () => {
  for (const value of ['not json', '', null, undefined, 'null', '[1,2,3]', '{"unterminated": true']) {
    assert.equal(claude.parseClaudeStatus(value), null, String(value));
  }
});

test('status: a failed sign-in state read is an error, never a plain sign-out', () => {
  const failedRead = { installed: true, status: null, statusError: true, now };
  const off = claude.describeClaudeFacts({ ...failedRead, routeOn: false });
  assert.equal(off.state, 'signed-out');
  assert.equal(off.error, "Could not read Claude Code's sign-in state");
  const on = claude.describeClaudeFacts({ ...failedRead, routeOn: true });
  assert.equal(on.state, 'needs-reconnect');
  assert.equal(on.error, "Could not read Claude Code's sign-in state");
  // Not installed and no read attempted: no read error.
  assert.equal(
    claude.describeClaudeFacts({ installed: false, status: null, routeOn: false, statusError: false, now }).error,
    null,
  );
  // The API-account sentence is unchanged and keeps precedence over a configuration error.
  const api = claude.describeClaudeFacts({
    installed: true, status: statusOf({ authMethod: 'apiKey' }), routeOn: true, statusError: false, configError: true, now,
  });
  assert.equal(api.state, 'needs-reconnect');
  assert.equal(api.error, 'Claude Code is signed in with an API account, not a Claude plan.');
  // A configuration that cannot be read is still reported.
  assert.equal(
    claude.describeClaudeFacts({ installed: true, status: statusOf(), routeOn: true, statusError: false, configError: true, now }).error,
    'Could not read the agent configuration.',
  );
});

// ---- claudeRouteOn / routeRemovalPatch -----------------------------------------------------

const routeOnConfig = (models) => ({ agents: { defaults: { models } } });
const ON = { 'anthropic/*': { agentRuntime: { id: 'claude-cli' } } };

test('route: the Claude Code rule is recognised and only by its runtime id', () => {
  assert.equal(claude.claudeRouteOn(routeOnConfig(ON)), true);
  assert.equal(claude.claudeRouteOn(routeOnConfig({ ...ON, 'openai/*': { agentRuntime: { id: 'codex' } } })), true);
  assert.equal(claude.claudeRouteOn(routeOnConfig({ 'anthropic/*': { agentRuntime: { id: 'default' } } })), false);
  assert.equal(claude.claudeRouteOn(routeOnConfig({ 'anthropic/*': { agentRuntime: null } })), false);
  assert.equal(claude.claudeRouteOn(routeOnConfig({ 'anthropic/*': {} })), false);
  assert.equal(claude.claudeRouteOn(routeOnConfig({})), false);
  assert.equal(claude.claudeRouteOn({ agents: { defaults: {} } }), false);
  assert.equal(claude.claudeRouteOn({}), false);
  assert.equal(claude.claudeRouteOn(null), false);
  assert.equal(claude.claudeRouteOn(undefined), false);
  assert.equal(claude.claudeRouteOn('anthropic/*'), false);
});

test('route: no models or no rule gives no removal patch', () => {
  assert.equal(claude.routeRemovalPatch({}), null);
  assert.equal(claude.routeRemovalPatch({ agents: { defaults: {} } }), null);
  assert.equal(claude.routeRemovalPatch(routeOnConfig({ 'openai/*': { agentRuntime: { id: 'codex' } } })), null);
  assert.equal(claude.routeRemovalPatch(routeOnConfig({ 'anthropic/*': { agentRuntime: { id: 'default' } } })), null);
});

test('route: the removal patch nulls the only key instead of leaving an empty models object', () => {
  assert.deepEqual(claude.routeRemovalPatch(routeOnConfig(ON)), { agents: { defaults: { models: null } } });
});

test('route: other keys are never touched', () => {
  const config = routeOnConfig({ ...ON, 'openai/*': { agentRuntime: { id: 'codex' } } });
  const patch = claude.routeRemovalPatch(config);
  assert.deepEqual(patch, { agents: { defaults: { models: { 'anthropic/*': null } } } });
  assert.equal(JSON.stringify(patch).includes('openai'), false);
});

test('route: the on patch is the verified OpenClaw shape', () => {
  assert.deepEqual(claude.ROUTE_ON_PATCH, {
    agents: { defaults: { models: { 'anthropic/*': { agentRuntime: { id: 'claude-cli' } } } } },
  });
});

// ---- claudeState ---------------------------------------------------------------------------

test('state: not installed wins over everything', () => {
  for (const status of [null, statusOf(), statusOf({ loggedIn: false })]) {
    assert.equal(claude.claudeState({ installed: false, status, routeOn: true, now }), 'not-installed');
  }
});

test('state: signed out with and without the route', () => {
  assert.equal(claude.claudeState({ installed: true, status: statusOf({ loggedIn: false }), routeOn: false, now }), 'signed-out');
  assert.equal(claude.claudeState({ installed: true, status: null, routeOn: false, now }), 'signed-out');
  assert.equal(claude.claudeState({ installed: true, status: statusOf({ loggedIn: false }), routeOn: true, now }), 'needs-reconnect');
  assert.equal(claude.claudeState({ installed: true, status: null, routeOn: true, now }), 'needs-reconnect');
});

test('state: connected, route off and expired', () => {
  assert.equal(claude.claudeState({ installed: true, status: statusOf(), routeOn: true, now }), 'connected');
  assert.equal(claude.claudeState({ installed: true, status: statusOf(), routeOn: false, now }), 'route-off');
  assert.equal(
    claude.claudeState({ installed: true, status: statusOf({ expiresAt: '2026-12-11T06:00:17.212Z' }), routeOn: true, now }),
    'connected',
  );
  assert.equal(
    claude.claudeState({ installed: true, status: statusOf({ expiresAt: '2026-10-01T00:00:00.000Z' }), routeOn: true, now }),
    'needs-reconnect',
  );
  assert.equal(
    claude.claudeState({ installed: true, status: statusOf({ expiresAt: '2026-10-01T00:00:00.000Z' }), routeOn: false, now }),
    'signed-out',
  );
});

test('state: an API or Console sign-in is not a Claude plan', () => {
  for (const authMethod of ['console', 'apiKey', 'none', null]) {
    assert.equal(
      claude.claudeState({ installed: true, status: statusOf({ authMethod }), routeOn: true, now }),
      'needs-reconnect',
      String(authMethod),
    );
    assert.equal(
      claude.claudeState({ installed: true, status: statusOf({ authMethod }), routeOn: false, now }),
      'signed-out',
      String(authMethod),
    );
  }
});

// ---- login job transitions -----------------------------------------------------------------

test('job: the install path goes back to starting, reaches waiting and accepts a code', () => {
  // The install leaves the job in `installing`; after it, the job signs in from `starting`.
  assert.equal(claude.claudeLoginAfterInstall('installing'), 'starting');
  assert.equal(claude.claudeLoginAfterInstall('starting'), 'starting');
  const stored = claude.claudeLoginOnOutput('starting', { output: '', failed: null }, loginOutput(BEL));
  const p = claude.parseClaudeLogin(stored.output);
  assert.equal(p.url, URL_CLAUDE);
  assert.equal(p.prompted, true);
  const waiting = claude.claudeLoginOnPrompt('starting', p.url, p.prompted);
  assert.equal(waiting, 'waiting');
  // A code is accepted only from `waiting`, and only once.
  assert.equal(claude.claudeLoginSubmitState(waiting, false), 'verifying');
  assert.equal(claude.claudeLoginSubmitState(waiting, true), null);
  assert.equal(claude.claudeLoginSubmitState('installing', false), null);
  assert.equal(claude.claudeLoginSubmitState('starting', false), null);
});

test('job: the deadline ends only starting, installing and waiting', () => {
  for (const state of ['starting', 'installing', 'waiting']) {
    assert.equal(claude.claudeLoginDeadlineApplies(state), true, state);
  }
  for (const state of ['verifying', 'connecting', 'connected', 'failed', 'expired', 'cancelled']) {
    assert.equal(claude.claudeLoginDeadlineApplies(state), false, state);
  }
});

test('job: after submit only the parsed failure sentence is kept, never the code echo', () => {
  const code = 'SECRET-CODE-123456';
  const echo = claude.claudeLoginOnOutput('verifying', { output: '', failed: null }, `${code}\r\n`);
  assert.deepEqual(echo, { output: '', failed: null });
  assert.equal(JSON.stringify(echo).includes(code), false);
  // The failure line is kept as the parsed sentence.
  const failed = claude.claudeLoginOnOutput('verifying', echo, 'Login failed: That code was not accepted.\r\n');
  assert.deepEqual(failed, { output: '', failed: 'That code was not accepted.' });
  // The same while connecting.
  const connecting = claude.claudeLoginOnOutput('connecting', { output: '', failed: failed.failed }, `${code}\r\n`);
  assert.equal(connecting.output, '');
  assert.equal(connecting.failed, 'That code was not accepted.');
  assert.equal(JSON.stringify(connecting).includes(code), false);
  // Before submit the raw output is still accumulated to read the link and the prompt.
  const before = claude.claudeLoginOnOutput('waiting', { output: 'Opening ', failed: null }, 'browser');
  assert.deepEqual(before, { output: 'Opening browser', failed: null });
});

// ---- ignoreLogin ---------------------------------------------------------------------------

await testAsync('busy: ignoreLogin skips only the provider being started, true skips both', async () => {
  const both = loadAgentBusy({ openai: true, claude: true });
  // Each start ignores only its own placeholder: the other provider's login still blocks.
  assert.equal(
    await both.agentBusyReason('agent_fixture', { ignoreLogin: 'openai' }),
    'A subscription login for this agent is running',
  );
  assert.equal(
    await both.agentBusyReason('agent_fixture', { ignoreLogin: 'anthropic' }),
    'A subscription login for this agent is running',
  );
  // `true` keeps the historical meaning: both logins are skipped.
  assert.equal(await both.agentBusyReason('agent_fixture', { ignoreLogin: true }), null);
  // Without the ignore flag, either login is busy.
  assert.equal(await both.agentBusyReason('agent_fixture'), 'A subscription login for this agent is running');

  const openaiOnly = loadAgentBusy({ openai: true, claude: false });
  assert.equal(await openaiOnly.agentBusyReason('agent_fixture', { ignoreLogin: 'openai' }), null);
  assert.equal(
    await openaiOnly.agentBusyReason('agent_fixture', { ignoreLogin: 'anthropic' }),
    'A subscription login for this agent is running',
  );

  const claudeOnly = loadAgentBusy({ openai: false, claude: true });
  assert.equal(await claudeOnly.agentBusyReason('agent_fixture', { ignoreLogin: 'anthropic' }), null);
  assert.equal(
    await claudeOnly.agentBusyReason('agent_fixture', { ignoreLogin: 'openai' }),
    'A subscription login for this agent is running',
  );

  const idle = loadAgentBusy({ openai: false, claude: false });
  for (const ignoreLogin of [true, 'openai', 'anthropic', false]) {
    assert.equal(await idle.agentBusyReason('agent_fixture', { ignoreLogin }), null, String(ignoreLogin));
  }
});

// ---- anthropic prefix ----------------------------------------------------------------------

test('prefix: a bare anthropic/ model is a subscription model only with its own prefix', () => {
  assert.equal(isSubscriptionModel('anthropic/claude-x'), false);
  assert.equal(isSubscriptionModel('anthropic/claude-x', 'anthropic/'), true);
  assert.equal(isSubscriptionModel('rev4a/anthropic/claude-x', 'anthropic/'), false);
  assert.equal(isSubscriptionModel('openai/gpt-x', 'anthropic/'), false);
  assert.equal(isSubscriptionModel(null, 'anthropic/'), false);
});

test('prefix: revert of a Claude primary uses its own fallback', () => {
  const r = revertSubscriptionModel({ primary: 'anthropic/claude-x', fallbacks: ['rev4a/deepseek-flash'] }, null, 'anthropic/');
  assert.deepEqual([r.stuck, r.changed, r.primary, r.fallbacks], [false, true, 'rev4a/deepseek-flash', []]);
});

test('prefix: revert of a Claude primary with no fallback is stuck', () => {
  const r = revertSubscriptionModel({ primary: 'anthropic/claude-x', fallbacks: [] }, null, 'anthropic/');
  assert.equal(r.stuck, true);
  const onlySub = revertSubscriptionModel({ primary: 'anthropic/a', fallbacks: ['anthropic/b'] }, null, 'anthropic/');
  assert.equal(onlySub.stuck, true);
});

test('prefix: a rev4a proxy model is untouched by the Claude revert', () => {
  const m = { primary: 'rev4a/anthropic/claude-x', fallbacks: ['rev4a/deepseek-flash'] };
  const r = revertSubscriptionModel(m, null, 'anthropic/');
  assert.deepEqual([r.stuck, r.changed, r.primary, r.fallbacks], [false, false, m.primary, m.fallbacks]);
});

test('prefix: the default behaviour for openai is unchanged', () => {
  const r = revertSubscriptionModel({ primary: 'openai/a', fallbacks: ['openai/b', 'rev4a/x', 'rev4a/y'] });
  assert.deepEqual([r.stuck, r.changed, r.primary, r.fallbacks], [false, true, 'rev4a/x', ['rev4a/y']]);
  // An anthropic model is not an OpenAI subscription model without the prefix.
  const keep = revertSubscriptionModel({ primary: 'anthropic/claude-x', fallbacks: ['rev4a/x'] });
  assert.equal(keep.changed, false);
  assert.equal(keep.primary, 'anthropic/claude-x');
});

// ---- module boundaries and the security rules this card is about ---------------------------

test('parse helpers: no imports at all (loaded directly by the tests)', () => {
  const source = fsx.readFileSync(new URL('../lib/subscription-claude-parse.ts', import.meta.url), 'utf8');
  assert.equal(/(^|\n)\s*import\s/.test(source), false, 'no import statements');
  assert.equal(/from\s+['"]/.test(source), false, 'no module specifier');
  // The only `require` is inside the fixed in-container script text, which runs in the container.
  const beforeScript = source.slice(0, source.indexOf('export const CLAUDE_STATUS_SCRIPT_SRC'));
  assert.equal(/require\s*\(/.test(beforeScript), false, 'no module loading');
});

test('server module: never touches a Claude credential file or a setup-token method', () => {
  const source = fsx.readFileSync(new URL('../lib/subscription-claude.ts', import.meta.url), 'utf8');
  for (const forbidden of ['.credentials.json', '/root/.claude.json', 'setup-token', 'paste-token', '--method']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes('https://claude.ai/install.sh'), true, 'the installer is the verified one');
  assert.equal(source.includes('claude auth login'), true, 'the sign-in is Claude Code\'s own');
  assert.equal(source.includes("'auth', 'logout'"), true, 'the sign-out is Claude Code\'s own');
});

test('connect: IS_SANDBOX=1 is set after the route is on, and a failure never fails the connection (BUG-22)', () => {
  const source = fsx.readFileSync(new URL('../lib/subscription-claude.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function verifyAndConnect'));
  const fn = body.slice(0, body.indexOf('\n}'));
  assert.ok(fn.indexOf('await writeRouteOn') < fn.indexOf('await ensureSandboxEnvInAgent'), 'after the route is written');
  assert.ok(fn.indexOf('await ensureSandboxEnvInAgent') < fn.indexOf("finish(j, 'connected')"), 'before connected is reported');
  const helper = source.slice(source.indexOf('async function ensureSandboxEnvInAgent'));
  const hbody = helper.slice(0, helper.indexOf('\n}'));
  assert.match(hbody, /catch \{/, 'an exec failure is caught');
  assert.match(hbody, /console\.warn/, 'and logged');
  assert.equal(/throw|finish\(/.test(hbody), false, 'never fatal');
  assert.match(hbody, /timeoutMs: 15_000/, 'bounded');
});

test('status read: an unsupported OpenClaw line is refused like the ChatGPT read', () => {
  const source = fsx.readFileSync(new URL('../lib/subscription-claude.ts', import.meta.url), 'utf8');
  const read = source.slice(source.indexOf('export async function readClaudeAgent'));
  assert.match(read, /runsSupportedVersion\(a\.container\)/);
  assert.match(read, /out\.error = UNSUPPORTED_AGENT_MESSAGE/);
});

test('busy: each login start ignores only its own provider', () => {
  const openai = fsx.readFileSync(new URL('../lib/subscription-login.ts', import.meta.url), 'utf8');
  const anthropic = fsx.readFileSync(new URL('../lib/subscription-claude.ts', import.meta.url), 'utf8');
  assert.match(openai, /agentBusyReason\(a\.agentId, \{ ignoreLogin: 'openai' \}\)/);
  assert.match(anthropic, /agentBusyReason\(a\.agentId, \{ ignoreLogin: 'anthropic' \}\)/);
});

test('cancel: both providers take the child before finish clears it', () => {
  for (const file of ['../lib/subscription-claude.ts', '../lib/subscription-login.ts']) {
    const source = fsx.readFileSync(new URL(file, import.meta.url), 'utf8');
    const start = source.indexOf('export async function cancel');
    assert.notEqual(start, -1, file);
    const body = source.slice(start);
    const capture = body.indexOf('const child = j.child;');
    const finishCall = body.indexOf('finish(j,');
    assert.notEqual(capture, -1, file);
    assert.ok(capture < finishCall, `${file}: the child is captured before finish()`);
    assert.equal(body.includes('child?.kill('), true, file);
  }
});

test('server module: the code is written once and never stored, logged or returned', () => {
  const source = fsx.readFileSync(new URL('../lib/subscription-claude.ts', import.meta.url), 'utf8');
  const job = source.slice(source.indexOf('interface Job extends ClaudeLoginView {'));
  assert.equal(/\bcode\s*:/.test(job.slice(0, job.indexOf('\n}'))), false, 'the job has no code field');
  const submit = source.slice(source.indexOf('export async function submitClaudeCode'));
  const body = submit.slice(0, submit.indexOf('\n}'));
  assert.equal(body.includes('console.'), false, 'no logging in submitClaudeCode');
  assert.equal(body.includes('j.' + 'code '), false, 'the code is never put on the job');
});

/** Evaluates a fixed `const NAME = '...' + '...';` script constant out of a TypeScript source. */
function scriptConstant(file, name) {
  const source = fsx.readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `${name} in ${file}`);
  const end = source.indexOf(";\n", start);
  return vm.runInNewContext(source.slice(start + `const ${name} =`.length, end));
}
const globMatches = (script, cmd) => {
  const pattern = script.match(/case "\$c" in (.+?)\) \[/)[1];
  return execFileSync('sh', ['-c', 'case "$1" in ' + pattern + ') echo y;; *) echo n;; esac', 'x', cmd], { encoding: 'utf8' }).trim() === 'y';
};

test('kill scripts: the script text never matches its own pattern, and the pattern still covers the real command lines', () => {
  const cases = [
    ['../lib/subscription-claude.ts', 'KILL_CLAUDE_SCRIPT', 'claude auth login', [
      'timeout 960 script -e -qfc /root/.local/bin/claude auth login /dev/null',
      'script -e -qfc /root/.local/bin/claude auth login /dev/null',
      'sh -c /root/.local/bin/claude auth login',
    ]],
    ['../lib/subscription-login.ts', 'KILL_LOGIN_SCRIPT', 'models auth login --provider openai --device-code', [
      'timeout 960 script -e -qfc openclaw models auth login --provider openai --device-code /dev/null',
      'openclaw models auth login --provider openai --device-code',
    ]],
  ];
  for (const [file, name, phrase, commands] of cases) {
    const script = scriptConstant(file, name);
    execFileSync('sh', ['-n', '-c', script]);
    assert.equal(script.includes(phrase), false, `${name}: the script text must not hold \"${phrase}\" contiguously`);
    // The wrapper that runs it (`timeout -k 1 5 sh -c '<script>'`) has the script in its command line.
    assert.equal(globMatches(script, `timeout -k 1 5 sh -c ${script}`), false, `${name}: does not match its own wrapper`);
    for (const cmd of commands) assert.equal(globMatches(script, cmd), true, `${name}: covers ${cmd}`);
    assert.equal(globMatches(script, 'openclaw models auth login --provider anthropic'), false);
  }
});

test('cancel: a submitted code finishes on its own (configuration writes and the terms read)', () => {
  const source = fsx.readFileSync(new URL('../lib/subscription-claude.ts', import.meta.url), 'utf8');
  const cancel = source.slice(source.indexOf('export async function cancelClaudeLogin'));
  const body = cancel.slice(0, cancel.indexOf('\n}'));
  const guard = body.indexOf('if (j.codeSubmitted) return view(j);');
  assert.notEqual(guard, -1, 'a submitted code returns the current view');
  assert.ok(guard < body.indexOf('j.cancelled = true'), 'before anything is changed');
  assert.ok(guard < body.indexOf('KILL_CLAUDE_SCRIPT'), 'and before the sign-in is killed');
  const remove = source.slice(source.indexOf('async function removeClaudeRoute'));
  assert.match(remove.slice(0, remove.indexOf('\n}')), /if \(before\.configError\) throw new SubscriptionError\(502, 'Could not read the agent configuration\.'\)/);
  const patch = source.slice(source.indexOf('async function patchConfig'));
  assert.match(patch.slice(0, patch.indexOf('\n}')), /if \(!after\.configError && applied\(after\.models\)\) return;/);
});

/** Loads lib/subscription-claude.ts with Docker and the agent lookups stubbed; the parse helpers run for real. */
function loadClaudeModule({ reads, execs, leanCalls = [], sandboxEnvAnswer = '{"result":"set"}\n' }) {
  const source = fsx.readFileSync(new URL('../lib/subscription-claude.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console, Date, JSON, Map, Promise, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  class SubscriptionError extends Error { constructor(status, message) { super(message); this.status = status; } }
  let read = 0;
  const dependencies = {
    child_process: { spawn: () => { throw new Error('no spawn'); } },
    '@/lib/docker-exec': {
      dockerExec: async (_c, argv, opts) => {
        if (argv[0] === 'node' && argv[2] === sandboxEnv.ENSURE_SANDBOX_ENV_SCRIPT) {
          execs.push(['sandbox-env']);
          return sandboxEnvAnswer;
        }
        if (argv[0] === 'node') return JSON.stringify(reads[Math.min(read++, reads.length - 1)]);
        execs.push(argv);
        return '';
      },
      dockerExecNoFail: async () => '',
      dockerExecWithInput: async (_c, argv, input) => { execs.push([...argv, input]); return ''; },
      mapWithConcurrency: async () => [],
    },
    '@/lib/container': { isValidAgentId: () => true },
    '@/lib/agent-config-lock': { withAgentConfigLock: async (_c, fn) => fn() },
    '@/lib/gateway-cli': { gatewayCliArgv },
    '@/lib/docker-socket': { resolveDockerSocket: () => '/sock' },
    '@/lib/subscriptions': {
      SubscriptionError,
      UNSUPPORTED_AGENT_MESSAGE: 'unsupported',
      findAgentContainer: async () => ({ agentId: 'a1', container: 'c1', running: true, displayName: 'A' }),
      invalidateSubscriptions() {},
      listAgentContainers: async () => [],
      revertAgentSubscriptionModels: async () => undefined,
      runsSupportedVersion: async () => 'supported',
      statusReadFailedMessage: (r) => r,
      subscriptionGeneration: () => 0,
      withAgentLock: async (_id, fn) => fn(),
    },
    '@/lib/credentials/native': { OPENCLAW_RELOAD_TIMEOUT_MS: 150000 },
    '@/lib/subscription-claude-parse': claude,
    '@/lib/subscriptions-parse': require('../lib/subscriptions-parse.js'),
    '@/lib/claude-sandbox-env': sandboxEnv,
    '@/lib/claude-lean-tools': { ensureLeanClaudeTools: async (c) => { leanCalls.push(c); return 'written'; } },
    '@/lib/claude-probe': { runClaudeProbe: async () => ({ failed: true }) },
  };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', sandbox)(
    (name) => {
      if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return { mod: module.exports, SubscriptionError };
}

await testAsync('disconnect: an unreadable configuration is a 502, never a false success', async () => {
  const loggedIn = { loggedIn: true, authMethod: 'claude.ai', email: 'me@example.invalid', subscriptionType: 'pro' };
  const execs = [];
  const unreadable = { installed: true, version: '2.1.325', status: loggedIn, statusError: false, models: null, model: null, error: 'config' };
  const { mod } = loadClaudeModule({ reads: [unreadable], execs });
  await assert.rejects(() => mod.disconnectClaudeAgent('a1'), (e) => e.status === 502 && e.message === 'Could not read the agent configuration.');
  assert.equal(execs.length, 0, 'nothing was patched and no sign-out ran');
});

await testAsync('disconnect: a read-back that could not read the configuration does not count as applied', async () => {
  const loggedIn = { loggedIn: true, authMethod: 'claude.ai', email: 'me@example.invalid', subscriptionType: 'pro' };
  const routeOn = { 'anthropic/*': { agentRuntime: { id: 'claude-cli' } } };
  const base = { installed: true, version: '2.1.325', status: loggedIn, statusError: false, model: null };
  const execs = [];
  const { mod } = loadClaudeModule({
    reads: [
      { ...base, models: routeOn, error: null },
      { ...base, models: routeOn, error: null },
      { ...base, models: null, error: 'config' },
    ],
    execs,
  });
  await assert.rejects(() => mod.disconnectClaudeAgent('a1'), (e) => e.status === 502);
  assert.deepEqual(execs.find((argv) => argv.includes('patch'))?.slice(0, -1),
    gatewayCliArgv(['config', 'patch', '--stdin']), 'the patch was attempted with the Gateway wrapper');
  assert.equal(execs.some((argv) => argv.includes('logout')), false, 'the sign-out did not run after a failed removal');
});

test('connect: the lean tools list is requested after the sandbox step and is not fatal', () => {
  const source = fsx.readFileSync(new URL('../lib/subscription-claude.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function verifyAndConnect'));
  const sandbox = body.indexOf('await ensureSandboxEnvInAgent(j.container);');
  const lean = body.indexOf('await ensureLeanClaudeTools(j.container);');
  assert.ok(sandbox > 0 && lean > sandbox, 'right after ensureSandboxEnvInAgent');
  assert.ok(lean < body.indexOf("finish(j, 'connected')"), 'before the connection is reported');
  assert.equal(body.slice(sandbox, lean).includes('withAgentConfigLock'), false, 'not inside a lock hold');
});

test('api account: the facts carry a machine-readable flag, only for that case', () => {
  const base = { installed: true, routeOn: false, statusError: false, now: Date.now() };
  const api = claude.describeClaudeFacts({ ...base, status: { loggedIn: true, authMethod: 'api', email: null, plan: null, expiresAt: null } });
  assert.equal(api.apiAccount, true);
  assert.ok(api.error);
  const plan = claude.describeClaudeFacts({ ...base, status: { loggedIn: true, authMethod: 'claude.ai', email: null, plan: 'Pro', expiresAt: null } });
  assert.equal(plan.apiAccount, false);
  assert.equal(claude.describeClaudeFacts({ ...base, status: null, statusError: true }).apiAccount, false);
  assert.equal(claude.describeClaudeFacts({ ...base, status: null, configError: true }).apiAccount, false);
});

test('status script: runs as written, whitelists and reports the configuration', () => {
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'rev4a-claude-'));
  try {
    const bin = pathx.join(dir, 'claude');
    const authJson = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'me@example.invalid',
      orgName: 'Example',
      subscriptionType: 'pro',
      loginExpiresAt: '2026-12-11T06:00:17.212Z',
      accessToken: 'ACCESS-SECRET',
      orgId: 'ORG-SECRET',
    });
    fsx.writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.325 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ]; then',
      "cat <<'JSON'",
      authJson,
      'JSON',
      'exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    const cfg = pathx.join(dir, 'openclaw.json');
    fsx.writeFileSync(cfg, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-x', fallbacks: ['rev4a/deepseek-flash'] },
          models: { 'anthropic/*': { agentRuntime: { id: 'claude-cli' } } },
        },
      },
    }));

    const script = (binPath, configPath) => claude.CLAUDE_STATUS_SCRIPT_SRC
      .split('/root/.local/bin/claude').join(binPath)
      .split('/root/.openclaw/openclaw.json').join(configPath);
    assert.notEqual(script(bin, cfg), claude.CLAUDE_STATUS_SCRIPT_SRC, 'the fixed paths are in the script');

    const out = execFileSync(process.execPath, ['--no-warnings', '-e', script(bin, cfg)], { encoding: 'utf8' });
    assert.equal(/ACCESS-SECRET|ORG-SECRET/.test(out), false, 'no token or organisation id leaves the script');
    const parsed = JSON.parse(out);
    assert.equal(parsed.installed, true);
    assert.equal(parsed.version, '2.1.325 (Claude Code)');
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.model, { primary: 'anthropic/claude-x', fallbacks: ['rev4a/deepseek-flash'] });
    const status = claude.parseClaudeStatus(parsed.status);
    assert.equal(status.loggedIn, true);
    assert.equal(status.email, 'me@example.invalid');
    assert.equal(status.plan, 'Pro');
    assert.equal(claude.claudeRouteOn({ agents: { defaults: { models: parsed.models } } }), true);

    // A missing binary: installed false, the configuration is still read.
    const noBin = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', script(pathx.join(dir, 'missing'), cfg)], { encoding: 'utf8' }));
    assert.equal(noBin.installed, false);
    assert.equal(noBin.status, null);
    assert.equal(claude.claudeRouteOn({ agents: { defaults: { models: noBin.models } } }), true);

    // An unreadable configuration: error 'config', the status is still printed.
    const noCfg = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', script(bin, pathx.join(dir, 'none.json'))], { encoding: 'utf8' }));
    assert.equal(noCfg.error, 'config');
    assert.equal(noCfg.model, null);
    assert.equal(noCfg.installed, true);
    assert.equal(noCfg.status.loggedIn, true);

    // A warning line before the JSON is still read.
    const warnBin = pathx.join(dir, 'claude-warn');
    fsx.writeFileSync(warnBin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.325 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ]; then',
      'echo "(node:1) ExperimentalWarning: something"',
      "cat <<'JSON'",
      authJson,
      'JSON',
      'exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    const warned = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', script(warnBin, cfg)], { encoding: 'utf8' }));
    assert.equal(warned.statusError, false);
    assert.equal(warned.status.loggedIn, true);
    assert.equal(claude.parseClaudeStatus(warned.status).plan, 'Pro');

    // Logged out, `claude auth status --json` exits 1 but prints the JSON (Claude Code 2.1.325,
    // seen live 2026-11-14): that is a signed-out agent, not a failed read.
    const outBin = pathx.join(dir, 'claude-out');
    fsx.writeFileSync(outBin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.325 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ]; then',
      "cat <<'JSON'",
      JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', loginExpiresAt: null, consoleProfileSignInOffered: true }),
      'JSON',
      'exit 1',
      'fi',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    const loggedOut = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', script(outBin, cfg)], { encoding: 'utf8' }));
    assert.equal(loggedOut.statusError, false);
    assert.equal(loggedOut.status.loggedIn, false);
    assert.equal(
      claude.describeClaudeFacts({ installed: true, status: loggedOut.status, statusError: loggedOut.statusError, routeOn: false }).error,
      null,
    );

    // A failed or non-JSON status command is reported, not turned into a sign-out.
    const brokenBin = pathx.join(dir, 'claude-broken');
    fsx.writeFileSync(brokenBin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.325 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ]; then echo "not json"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    const broken = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', script(brokenBin, cfg)], { encoding: 'utf8' }));
    assert.equal(broken.installed, true);
    assert.equal(broken.status, null);
    assert.equal(broken.statusError, true);
    assert.equal(
      claude.describeClaudeFacts({ installed: true, status: broken.status, statusError: broken.statusError, routeOn: true }).error,
      "Could not read Claude Code's sign-in state",
    );
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- usage limits --------------------------------------------------------------------------

const EVENT = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794671400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.16,"resetsAt":1794671400,"status":"allowed"},"seven_day":{"utilization":0.14,"resetsAt":1795190400,"status":"allowed"}}},"uuid":"u1","session_id":"s1"}';
const stream = (event) => [
  '{"type":"system","subtype":"init","session_id":"s1","secret":"nope"}',
  event,
  '{"type":"assistant","message":{"content":[{"type":"text","text":"."}]}}',
  '{"type":"result","subtype":"success","total_cost_usd":0.000125}',
  '',
].join('\n');
const eventWith = (five, seven) => JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { unifiedWindows: {
    ...(five === undefined ? {} : { five_hour: { utilization: five, resetsAt: 1794671400 } }),
    ...(seven === undefined ? {} : { seven_day: { utilization: seven, resetsAt: 1795190400 } }),
  } },
});

test('usage: the exact event among other stream-json lines gives both windows', () => {
  assert.deepEqual(claude.parseClaudeUsageEvent(stream(EVENT)), [
    { label: '5 hours', usedPercent: 16, resetAt: new Date(1794671400 * 1000).toISOString() },
    { label: 'Week', usedPercent: 14, resetAt: new Date(1795190400 * 1000).toISOString() },
  ]);
});

test('usage: 0, 1, 1.5 and -0.2 are clamped to 0..100', () => {
  const p = (u) => claude.parseClaudeUsageEvent(stream(eventWith(u, 0.5)))[0].usedPercent;
  assert.equal(p(0), 0);
  assert.equal(p(1), 100);
  assert.equal(p(1.5), 100);
  assert.equal(p(-0.2), 0);
});

test('usage: a missing or non-finite utilization leaves the window out', () => {
  assert.deepEqual(claude.parseClaudeUsageEvent(stream(eventWith(null, 0.2))).map((w) => w.label), ['Week']);
  assert.deepEqual(claude.parseClaudeUsageEvent(stream(eventWith(0.2, undefined))).map((w) => w.label), ['5 hours']);
  assert.deepEqual(claude.parseClaudeUsageEvent(stream(eventWith('0.2', 0.1))).map((w) => w.label), ['Week']);
  assert.equal(claude.parseClaudeUsageEvent(stream(eventWith(null, null))), null);
});

test('usage: no event, garbage and non-strings give null; a window without a reset keeps null', () => {
  assert.equal(claude.parseClaudeUsageEvent(stream('{"type":"other"}')), null);
  assert.equal(claude.parseClaudeUsageEvent('not json at all'), null);
  assert.equal(claude.parseClaudeUsageEvent('{"type":"rate_limit_event"'), null);
  assert.equal(claude.parseClaudeUsageEvent(''), null);
  assert.equal(claude.parseClaudeUsageEvent(undefined), null);
  const noReset = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5 } } } });
  assert.equal(claude.parseClaudeUsageEvent(noReset)[0].resetAt, null);
});

test('usage: only the three known fields come back, nothing else from the stream', () => {
  const out = claude.parseClaudeUsageEvent(stream(EVENT));
  for (const w of out) assert.deepEqual(Object.keys(w).sort(), ['label', 'resetAt', 'usedPercent']);
  assert.equal(JSON.stringify(out).includes('nope'), false);
});

test('usage: the probe is the fixed command, with no input in it and no credential read', () => {
  assert.match(claude.CLAUDE_USAGE_PROBE, /^cd \/tmp && timeout 60 \/root\/\.local\/bin\/claude -p "\." --model haiku /);
  assert.match(claude.CLAUDE_USAGE_PROBE, /--tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --output-format stream-json --verbose 2>&1; true$/);
  // A call refused at the limit exits 1 but prints the event: the shell must not turn it into a failed exec.
  const refused = execFileSync('sh', ['-c', 'printf %s\\\\n ' + JSON.stringify(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1794671400, status: 'rejected' } } } })) + '; false; true'], { encoding: 'utf8' });
  assert.deepEqual(claude.parseClaudeUsageEvent(refused).map((w) => w.usedPercent), [100]);
  // A first event without windows does not hide a later good one; a reset time in milliseconds is dropped.
  const twoEvents = [
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.14, resetsAt: 1795190400000 } } } }),
  ].join('\n');
  assert.deepEqual(claude.parseClaudeUsageEvent(twoEvents), [{ label: 'Week', usedPercent: 14, resetAt: null }]);
  assert.equal(/credentials|\$\{|\$\(/.test(claude.CLAUDE_USAGE_PROBE), false);
});

console.log(`\n${n} tests passed`);
