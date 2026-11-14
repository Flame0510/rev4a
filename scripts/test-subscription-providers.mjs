/**
 * Tests of the subscription provider registry (lib/subscription-providers.ts) and the client
 * copy map (app/subscriptions/providers.ts): the entries today, the lookups that must refuse
 * unknown and prototype keys, and the UI strings that must stay exactly as they were.
 * Run: node scripts/test-subscription-providers.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const registry = await import('../lib/subscription-providers.ts');
const copy = await import('../app/subscriptions/providers.ts');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };

const OPENAI = {
  id: 'openai',
  name: 'ChatGPT (Codex)',
  shortName: 'ChatGPT',
  modelPrefix: 'openai/',
  loginPath: '/api/subscriptions/openai/login',
  logoutPath: '/api/subscriptions/openai/logout',
  loginKind: 'device-code',
  hasUsage: true,
  experimental: false,
};

const ANTHROPIC = {
  id: 'anthropic',
  name: 'Claude (via Claude Code)',
  shortName: 'Claude',
  modelPrefix: 'anthropic/',
  loginPath: '/api/subscriptions/anthropic/login',
  logoutPath: '/api/subscriptions/anthropic/logout',
  loginKind: 'link-code',
  hasUsage: true,
  experimental: true,
};

// ---- registry -------------------------------------------------------------------------

test('registry: two entries, ChatGPT (Codex) and Claude (via Claude Code)', () => {
  assert.equal(registry.SUBSCRIPTION_PROVIDERS.length, 2);
  assert.deepEqual({ ...registry.SUBSCRIPTION_PROVIDERS[0] }, OPENAI);
  assert.deepEqual({ ...registry.SUBSCRIPTION_PROVIDERS[1] }, ANTHROPIC);
  assert.equal(registry.SUBSCRIPTION_PROVIDERS[0].id, 'openai');
});

test('registry: the login kind is the dialog choice, never the provider id', () => {
  assert.equal(registry.getSubscriptionProvider('openai').loginKind, 'device-code');
  assert.equal(registry.getSubscriptionProvider('anthropic').loginKind, 'link-code');
});

test('registry: a known id gives its entry, the default one is the same object', () => {
  assert.equal(registry.getSubscriptionProvider('openai'), registry.SUBSCRIPTION_PROVIDERS[0]);
  assert.equal(registry.getSubscriptionProvider('anthropic'), registry.SUBSCRIPTION_PROVIDERS[1]);
  assert.equal(registry.DEFAULT_SUBSCRIPTION_PROVIDER, registry.SUBSCRIPTION_PROVIDERS[0]);
});

test('registry: anything else is null, prototype keys included', () => {
  for (const bad of ['nope', undefined, null, 42, {}, [], '__proto__', 'constructor', 'toString', 'OPENAI', 'ANTHROPIC', '']) {
    assert.equal(registry.getSubscriptionProvider(bad), null, String(bad));
  }
});

// ---- providerFromParam ----------------------------------------------------------------

test('provider parameter: missing or empty is the default provider', () => {
  assert.equal(registry.providerFromParam(null), registry.SUBSCRIPTION_PROVIDERS[0]);
  assert.equal(registry.providerFromParam(''), registry.SUBSCRIPTION_PROVIDERS[0]);
});

test('provider parameter: a known id gives its entry', () => {
  assert.equal(registry.providerFromParam('openai'), registry.SUBSCRIPTION_PROVIDERS[0]);
  assert.equal(registry.providerFromParam('anthropic'), registry.SUBSCRIPTION_PROVIDERS[1]);
});

test('provider parameter: unknown values are null, case-sensitive', () => {
  for (const bad of ['claude', 'Anthropic', 'OPENAI', '__proto__', 'constructor', 'openai ', ' openai', 'anthropic/']) {
    assert.equal(registry.providerFromParam(bad), null, bad);
  }
});

// ---- client copy map ------------------------------------------------------------------

test('copy: every registry provider has an entry', () => {
  for (const provider of registry.SUBSCRIPTION_PROVIDERS) {
    const entry = copy.getProviderCopy(provider.id);
    assert.ok(entry, `copy for ${provider.id}`);
  }
  for (const bad of ['nope', undefined, null, 42, {}]) assert.equal(copy.getProviderCopy(bad), null, String(bad));
  assert.equal(copy.getProviderCopy('__proto__'), null);
  assert.equal(copy.getProviderCopy('constructor'), null);
});

test('copy: the ChatGPT strings are exactly today\'s, character for character', () => {
  const c = copy.getProviderCopy('openai');
  assert.equal(c.modelsUnavailable, 'ChatGPT models are still unavailable. Refresh to try again.');
  assert.equal(c.modelsLoading, 'Loading ChatGPT models…');
  assert.equal(c.modelsPending, 'The agent is loading the ChatGPT catalogue after Connect; this takes about a minute.');
  assert.equal(c.usageShared, 'The limit is shared with your own use of Codex on the same account.');
  assert.equal(c.accountLabel, 'ChatGPT account');
  assert.equal(c.connectTitle('atlas'), 'Connect ChatGPT to atlas');
  assert.equal(c.codeHint, 'Enter this code on OpenAI with your ChatGPT account. It expires in 15 minutes.');
  assert.equal(c.waiting, 'Waiting for you to finish on OpenAI…');
  assert.equal(
    c.disconnectMessage('atlas', 'deepseek-flash'),
    'Disconnect atlas? It goes back to deepseek-flash and signs out of ChatGPT. Connecting again needs a new code.',
  );
});

test('copy: the Claude entry names Claude and Claude Code in plain English', () => {
  const c = copy.getProviderCopy('anthropic');
  assert.ok(c);
  for (const key of ['modelsUnavailable', 'modelsLoading', 'modelsPending', 'usageShared', 'accountLabel', 'codeHint', 'waiting']) {
    assert.equal(typeof c[key], 'string', key);
    assert.ok(c[key].length > 0, key);
  }
  assert.equal(c.connectTitle('atlas'), 'Connect Claude to atlas');
  assert.equal(
    c.disconnectMessage('atlas', 'deepseek-flash'),
    'Disconnect atlas? It goes back to deepseek-flash and signs out of Claude. Claude Code stays installed in the agent.',
  );
  assert.match(c.codeHint, /Anthropic/);
  assert.equal(c.usageShared, "The limits are your Claude plan's, shared with your own use of Claude.");
});

test('copy: the page subtitle is provider-neutral', () => {
  assert.equal(
    copy.SUBSCRIPTIONS_PAGE_DESCRIPTION,
    'Connect a subscription to your agents. You choose the model in the agent panel.',
  );
});

test('skeleton: the loading subtitle is the page subtitle, not the old ChatGPT sentence', () => {
  const skeleton = readFileSync(new URL('../app/subscriptions/SubscriptionsSkeleton.tsx', import.meta.url), 'utf8');
  // One source of truth: the skeleton re-exports the copy map constant instead of its own literal.
  assert.match(skeleton, /export \{ SUBSCRIPTIONS_PAGE_DESCRIPTION as SUBSCRIPTIONS_DESCRIPTION \} from '\.\/providers';/);
  assert.equal(/Connect a ChatGPT subscription/.test(skeleton), false);
  const loading = readFileSync(new URL('../app/subscriptions/loading.tsx', import.meta.url), 'utf8');
  assert.match(loading, /SUBSCRIPTIONS_DESCRIPTION/);
});

test('copy: the Claude row wording and the guided-dialog steps are all in the copy map', () => {
  const c = copy.getProviderCopy('anthropic');
  assert.equal(c.row.notConnected, 'Not connected');
  assert.equal(c.row.signedInNotInUse, 'Signed in, not in use');
  assert.equal(c.row.needsReconnect, 'Needs a new sign-in');
  assert.equal(c.row.connected, 'Connected');
  assert.equal(c.row.connectedUntil('14 Nov 2026'), 'Connected until 14 Nov 2026');
  assert.equal(c.row.connecting, 'Connecting…');
  assert.equal(c.row.disconnecting, 'Disconnecting…');
  const l = c.linkCode;
  for (const key of Object.keys(l)) {
    if (typeof l[key] === 'string') assert.ok(l[key].length > 0, key);
  }
  assert.equal(copy.EXPERIMENTAL_LABEL, 'Experimental');
  assert.equal(
    copy.CLAUDE_USAGE_NOTE,
    "Usage counts against your own Claude plan. Anthropic's limits assume ordinary individual use; for round-the-clock automation an API key is the safer choice.",
  );
  assert.equal(copy.CLAUDE_USAGE_LINK.label, 'Anthropic: using your Claude plan');
  assert.equal(
    copy.CLAUDE_USAGE_LINK.href,
    'https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan',
  );
  const chatgpt = copy.getProviderCopy('openai');
  assert.equal(chatgpt.linkCode, undefined, 'the ChatGPT dialog stays the device-code one');
  assert.equal(chatgpt.row, undefined, 'the ChatGPT row keeps its inline wording');
});

// ---- default provider binding ---------------------------------------------------------

test('default binding: the server default comes from the registry constant, not the list position', () => {
  const source = readFileSync(new URL('../lib/subscriptions.ts', import.meta.url), 'utf8');
  assert.match(source, /export const PROVIDER_ID = DEFAULT_SUBSCRIPTION_PROVIDER\.id;/);
  assert.match(source, /export const PROVIDER_NAME = DEFAULT_SUBSCRIPTION_PROVIDER\.name;/);
  assert.match(source, /IMPLEMENTED_PROVIDERS[^=]*= \[DEFAULT_SUBSCRIPTION_PROVIDER\.id, 'anthropic'\];/);
  assert.equal(/SUBSCRIPTION_PROVIDERS\[0\]/.test(source), false, 'no list-position default');
});

test('subscription line: bound to the openai descriptor, never to the default provider', () => {
  const source = readFileSync(new URL('../app/agents/SubscriptionLine.tsx', import.meta.url), 'utf8');
  assert.match(source, /const FOUND_PROVIDER = getSubscriptionProvider\('openai'\);/);
  assert.match(source, /if \(!FOUND_PROVIDER\) throw/);
  assert.equal(/DEFAULT_SUBSCRIPTION_PROVIDER/.test(source), false);
  // The Claude row is read once, by ModelSection, and passed down: the line reads nothing of its own.
  assert.match(source, /claudeStatus: ClaudeStatus \| null;/);
  assert.equal(/useClaudeStatus/.test(source), false);
  assert.equal(/api\/subscriptions\?agentId/.test(source), false);
});

test('page: the provider parameter takes only the id, and the full provider list is not imported', () => {
  const source = readFileSync(new URL('../app/subscriptions/PageClient.tsx', import.meta.url), 'utf8');
  assert.match(source, /const providerParam = \(providerId: string\): string =>/);
  assert.match(source, /const providerAnd = \(providerId: string\): string =>/);
  assert.match(source, /description=\{SUBSCRIPTIONS_PAGE_DESCRIPTION\}/);
  assert.equal(/SUBSCRIPTIONS_DESCRIPTION/.test(source), false);
  assert.equal(/SUBSCRIPTION_PROVIDERS/.test(source), false);
});

// ---- module boundaries ----------------------------------------------------------------

test('registry: no Node or server imports (the page imports it too)', () => {
  const source = readFileSync(new URL('../lib/subscription-providers.ts', import.meta.url), 'utf8');
  assert.equal(/from\s+['"]node:/.test(source), false, 'no node: import');
  assert.equal(/require\s*\(/.test(source), false, 'no require');
  assert.equal(/from\s+['"]@\//.test(source), false, 'no @/ import');
  assert.equal(/from\s+['"]\.\.?\//.test(source), false, 'no relative import');
  assert.equal(/(^|\n)\s*import\s/.test(source), false, 'no import statements at all');
});

console.log(`\n${n} tests passed`);
