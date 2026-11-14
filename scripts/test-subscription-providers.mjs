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
  hasUsage: true,
};

// ---- registry -------------------------------------------------------------------------

test('registry: one entry today, the ChatGPT (Codex) provider', () => {
  assert.equal(registry.SUBSCRIPTION_PROVIDERS.length, 1);
  assert.deepEqual({ ...registry.SUBSCRIPTION_PROVIDERS[0] }, OPENAI);
  assert.equal(registry.SUBSCRIPTION_PROVIDERS[0].id, 'openai');
});

test('registry: a known id gives its entry, the default one is the same object', () => {
  assert.equal(registry.getSubscriptionProvider('openai'), registry.SUBSCRIPTION_PROVIDERS[0]);
  assert.equal(registry.DEFAULT_SUBSCRIPTION_PROVIDER, registry.SUBSCRIPTION_PROVIDERS[0]);
});

test('registry: anything else is null, prototype keys included', () => {
  for (const bad of ['nope', undefined, null, 42, {}, [], '__proto__', 'constructor', 'toString', 'OPENAI', '']) {
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
});

test('provider parameter: unknown values are null, case-sensitive', () => {
  for (const bad of ['anthropic', 'OPENAI', '__proto__', 'constructor', 'openai ', ' openai']) {
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

// ---- default provider binding ---------------------------------------------------------

test('default binding: the server default comes from the registry constant, not the list position', () => {
  const source = readFileSync(new URL('../lib/subscriptions.ts', import.meta.url), 'utf8');
  assert.match(source, /export const PROVIDER_ID = DEFAULT_SUBSCRIPTION_PROVIDER\.id;/);
  assert.match(source, /export const PROVIDER_NAME = DEFAULT_SUBSCRIPTION_PROVIDER\.name;/);
  assert.match(source, /IMPLEMENTED_PROVIDERS[^=]*= \[DEFAULT_SUBSCRIPTION_PROVIDER\.id\];/);
  assert.equal(/SUBSCRIPTION_PROVIDERS\[0\]/.test(source), false, 'no list-position default');
});

test('subscription line: bound to the openai descriptor, never to the default provider', () => {
  const source = readFileSync(new URL('../app/agents/SubscriptionLine.tsx', import.meta.url), 'utf8');
  assert.match(source, /const FOUND_PROVIDER = getSubscriptionProvider\('openai'\);/);
  assert.match(source, /if \(!FOUND_PROVIDER\) throw/);
  assert.equal(/DEFAULT_SUBSCRIPTION_PROVIDER/.test(source), false);
});

test('page: the provider parameter takes only the id, and the full provider list is not imported', () => {
  const source = readFileSync(new URL('../app/subscriptions/PageClient.tsx', import.meta.url), 'utf8');
  assert.match(source, /const providerParam = \(providerId: string\): string =>/);
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
