#!/usr/bin/env node
/**
 * Tests for lib/credentials/native.ts: the provider -> env/skill mapping, the config patch
 * JSON, that no secret ever reaches an argv array, and the enable/disable plans.
 *
 *   node scripts/test-credentials-native.mjs
 */
import assert from 'node:assert/strict';
import * as n from '../lib/credentials/native.ts';

let passed = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { passed++; console.log(`ok   ${name}`); }, (e) => { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }));
    } else { passed++; console.log(`ok   ${name}`); }
  } catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

const SECRETS = {
  'github-pat': { token: 'ghp_SECRETVALUE1234' },
  vercel: { token: 'vcp_SECRETVALUE1234' },
  supabase: { accessToken: 'sbp_SECRETVALUE1234' },
  trello: { apiKey: 'trellokey_SECRET1234', token: 'ATTA_SECRETVALUE1234' },
  notion: { token: 'ntn_SECRETVALUE1234' },
};

test('provider -> env names', () => {
  const names = (id) => n.NATIVE_PROVIDERS[id].env.map((e) => e.name);
  assert.deepEqual(names('github-pat'), ['GH_TOKEN', 'GITHUB_TOKEN']);
  assert.deepEqual(names('vercel'), ['VERCEL_TOKEN']);
  assert.deepEqual(names('supabase'), ['SUPABASE_ACCESS_TOKEN']);
  assert.deepEqual(names('trello'), ['TRELLO_API_KEY', 'TRELLO_TOKEN']);
  assert.deepEqual(names('notion'), ['NOTION_API_TOKEN']);
});

test('provider -> skill binding', () => {
  assert.deepEqual(n.NATIVE_PROVIDERS.trello.skill, { name: 'trello', via: 'env' });
  assert.deepEqual(n.NATIVE_PROVIDERS.notion.skill, { name: 'notion', via: 'apiKey' });
  assert.equal(n.NATIVE_PROVIDERS.vercel.skill, undefined);
});

test('store inputs read the right vault fields', () => {
  assert.deepEqual(n.storeInputs('trello', SECRETS.trello), [
    { name: 'TRELLO_API_KEY', value: 'trellokey_SECRET1234' },
    { name: 'TRELLO_TOKEN', value: 'ATTA_SECRETVALUE1234' },
  ]);
  assert.equal(n.storeInputs('supabase', SECRETS.supabase)[0].value, 'sbp_SECRETVALUE1234');
  assert.throws(() => n.storeInputs('trello', { apiKey: 'x' }), /Missing token/);
});

test('notion patch uses a SecretRef, no plaintext', () => {
  const patch = n.enablePatch('notion', SECRETS.notion);
  assert.deepEqual(patch, { skills: { entries: { notion: { enabled: true, apiKey: { source: 'store', provider: 'default', id: 'NOTION_API_TOKEN' } } } } });
  assert.ok(!JSON.stringify(patch).includes('SECRETVALUE'));
});

test('trello patch carries the env map', () => {
  assert.deepEqual(n.enablePatch('trello', SECRETS.trello), {
    skills: { entries: { trello: { enabled: true, env: { TRELLO_API_KEY: 'trellokey_SECRET1234', TRELLO_TOKEN: 'ATTA_SECRETVALUE1234' } } } },
  });
});

test('github is only switched on; providers without a skill have no patch', () => {
  assert.deepEqual(n.enablePatch('github-pat', SECRETS['github-pat']), { skills: { entries: { github: { enabled: true } } } });
  assert.equal(n.enablePatch('vercel', SECRETS.vercel), null);
  assert.equal(n.disablePatch('vercel'), null);
});

test('disable patch deletes the skill entry with null', () => {
  assert.deepEqual(n.disablePatch('trello'), { skills: { entries: { trello: null } } });
});

test('no secret value appears in any argv, plan step or patch argv', () => {
  for (const [id, secret] of Object.entries(SECRETS)) {
    const argvs = [
      ...n.NATIVE_PROVIDERS[id].env.flatMap((e) => [n.storeSetArgv(e.name), n.storeRemoveArgv(e.name)]),
      ...n.enablePlan(id).map((s) => s.argv),
      ...n.disablePlan(id).map((s) => s.argv),
      [...n.CONFIG_PATCH_ARGV], [...n.SECRETS_RELOAD_ARGV], [...n.VERSION_ARGV],
    ];
    const flat = JSON.stringify(argvs);
    for (const v of Object.values(secret)) assert.ok(!flat.includes(v), `${id}: secret in argv`);
  }
});

test('store set reads the value from stdin', () => {
  assert.deepEqual(n.storeSetArgv('GH_TOKEN'), ['openclaw', 'secrets', 'store', 'set', 'GH_TOKEN', '--kind', 'env', '--value-file', '-']);
  assert.deepEqual(n.storeRemoveArgv('GH_TOKEN'), ['openclaw', 'secrets', 'store', 'rm', '--yes', 'GH_TOKEN']);
});

test('argv builders refuse a name that is not an env name', () => {
  assert.throws(() => n.storeSetArgv('gh token; rm'), /Invalid environment name/);
  assert.throws(() => n.storeRemoveArgv('--all'), /Invalid environment name/);
});

test('plans are idempotent: same input, same plan', () => {
  for (const id of Object.keys(SECRETS)) {
    assert.deepEqual(n.enablePlan(id), n.enablePlan(id));
    assert.deepEqual(n.disablePlan(id), n.disablePlan(id));
  }
});

test('plan order: store entries, skill patch (if any), reload', () => {
  assert.deepEqual(n.enablePlan('trello').map((s) => s.kind), ['store-set', 'store-set', 'config-patch', 'reload']);
  assert.deepEqual(n.enablePlan('vercel').map((s) => s.kind), ['store-set', 'reload']);
  assert.deepEqual(n.disablePlan('notion').map((s) => s.kind), ['store-rm', 'config-patch', 'reload']);
});

test('rm always carries --yes before the name', () => {
  for (const id of Object.keys(SECRETS)) {
    for (const e of n.NATIVE_PROVIDERS[id].env) {
      const a = n.storeRemoveArgv(e.name);
      assert.equal(a[a.indexOf('rm') + 1], '--yes');
      assert.equal(a[a.length - 1], e.name);
    }
  }
});

test('reload targets the agent gateway through env, not argv', () => {
  assert.deepEqual(n.SECRETS_RELOAD_ENV, { OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:3000' });
  assert.deepEqual([...n.SECRETS_RELOAD_ARGV], ['openclaw', 'secrets', 'reload']);
  for (const step of [...n.enablePlan('trello'), ...n.disablePlan('trello')]) {
    assert.ok(!step.argv.some((a) => a === '--token' || a === '--url' || a.startsWith('--token=') || a.startsWith('--url=')));
  }
});

test('every enable patch sets enabled: true; disable removes the entry', () => {
  for (const [id, secret] of Object.entries(SECRETS)) {
    const patch = n.enablePatch(id, secret);
    const skill = n.NATIVE_PROVIDERS[id].skill;
    if (!skill) { assert.equal(patch, null); continue; }
    assert.equal(patch.skills.entries[skill.name].enabled, true, id);
    assert.equal(n.disablePatch(id).skills.entries[skill.name], null, id);
  }
});

test('version gate: 2026.9.x and newer only', () => {
  assert.ok(n.supportsNative('OpenClaw 2026.9.3 (1391f7c)'));
  assert.ok(n.supportsNative('2026.10.1'));
  assert.ok(n.supportsNative('2027.1.0'));
  assert.ok(!n.supportsNative('2026.8.9'));
  assert.ok(!n.supportsNative('2026.7.1'));
  assert.ok(!n.supportsNative(null));
});

// ── failure paths, with the exec primitives injected ─────────────────────────────────

function fakeExec({ failOn = () => false, version = 'OpenClaw 2026.9.9 (bcfc888)' } = {}) {
  const calls = [];
  return {
    calls,
    run: async (argv, env) => {
      calls.push({ argv, env, input: null });
      if (argv[1] === '--version') return version;
      if (failOn(argv)) throw new Error(`exit 1 while running ${argv.join(' ')}`);
      return '';
    },
    runWithInput: async (argv, input) => {
      calls.push({ argv, env: undefined, input });
      if (failOn(argv, input)) throw new Error(`patch refused: ${input}`);
      return '';
    },
  };
}

test('a failed rm mid-way still attempts every other step', async () => {
  const exec = fakeExec({ failOn: (a) => a.includes('GH_TOKEN') });
  const errors = await n.runDisable(exec, 'github-pat');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /remove GH_TOKEN/);
  const kinds = exec.calls.map((c) => c.argv.slice(0, 4).join(' '));
  assert.deepEqual(kinds, [
    'openclaw secrets store rm', 'openclaw secrets store rm',
    'openclaw config patch --stdin', 'openclaw secrets reload',
  ]);
  assert.ok(exec.calls.some((c) => c.argv.includes('GITHUB_TOKEN')), 'the second rm ran');
});

test('every step failing returns every failure, none thrown', async () => {
  const exec = fakeExec({ failOn: () => true });
  const errors = await n.runDisable(exec, 'trello');
  assert.equal(errors.length, 4); // two rm, the patch, the reload
});

test('a clean disable reports no failure', async () => {
  assert.deepEqual(await n.runDisable(fakeExec(), 'notion'), []);
});

test('only an enabled or pending row is removed from the agent', () => {
  assert.equal(n.needsNativeRemoval({ enabled: true, pendingRemoval: false }), true);
  assert.equal(n.needsNativeRemoval({ enabled: false, pendingRemoval: true }), true);
  assert.equal(n.needsNativeRemoval({ enabled: false, pendingRemoval: false }), false); // replaced sibling: no rm
  assert.equal(n.needsNativeRemoval(null), false);
});

test('enable: values only on stdin, reload gets the gateway env', async () => {
  const exec = fakeExec();
  await n.runEnable(exec, 'trello', SECRETS.trello);
  for (const c of exec.calls) {
    const flat = JSON.stringify([c.argv, c.env ?? {}]);
    for (const v of Object.values(SECRETS.trello)) assert.ok(!flat.includes(v), 'secret in argv or env');
  }
  const reload = exec.calls.at(-1);
  assert.deepEqual(reload.argv, ['openclaw', 'secrets', 'reload']);
  assert.deepEqual(reload.env, { OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:3000' });
  assert.equal(exec.calls.filter((c) => c.input !== null).length, 3); // two store entries and the patch
});

test('enable refuses an old agent before writing anything', async () => {
  const exec = fakeExec({ version: 'OpenClaw 2026.7.2' });
  await assert.rejects(n.runEnable(exec, 'vercel', SECRETS.vercel), /2026\.9\.0 or newer/);
  assert.equal(exec.calls.length, 1);
});

test('an enable error never carries the secret, even escaped', async () => {
  const tricky = { apiKey: 'k"ey\\value1', token: 'tok\\"en9999' };
  const exec = fakeExec({ failOn: (a, input) => input !== undefined && input !== null && a.includes('patch') });
  await assert.rejects(n.runEnable(exec, 'trello', tricky), (e) => {
    for (const v of Object.values(tricky)) {
      assert.ok(!e.message.includes(v), 'raw value leaked');
      assert.ok(!e.message.includes(JSON.stringify(v).slice(1, -1)), 'escaped value leaked');
    }
    return true;
  });
});

test('redact: escaped, untrimmed and short forms', () => {
  const v = 'a"b\\c-secret';
  assert.equal(n.redact(`bad ${JSON.stringify({ t: v })}`, [v]), 'bad {"t":"***"}');
  assert.equal(n.redact('raw a"b\\c-secret here', [v]), 'raw *** here');
  assert.equal(n.redact('token  padded-value-1  end', ['  padded-value-1  ']), 'token***end');
  // short values: only as a whole token, never inside a word
  assert.equal(n.redact('key abc and abcdef', ['abc']), 'key *** and abcdef');
  assert.equal(n.redact('no secrets here', ['']), 'no secrets here');
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
