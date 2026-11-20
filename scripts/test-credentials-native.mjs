#!/usr/bin/env node
/**
 * Tests for lib/credentials/native.ts: the provider -> env/skill mapping, the config patch
 * JSON, that no secret ever reaches an argv array, and the enable/disable plans.
 *
 *   node scripts/test-credentials-native.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// native.ts imports gateway-cli without an extension, as Next resolves it; a small resolve
// hook gives plain Node the same view.
const hooks = `
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\\.\\w+$/.test(specifier)) {
    const p = new URL(specifier, context.parentURL).pathname + '.ts';
    if (existsSync(p)) return next(pathToFileURL(p).href, context);
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(import.meta.dirname + '/'));
const n = await import('../lib/credentials/native.ts');
const gw = await import('../lib/gateway-cli.ts');
import { writeRefusal, requiresContainerWrite } from '../lib/credentials/guard.ts';

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
  mongodb: { uri: 'mongodb+srv://reader:p%40ss$w\'rd"@cluster0.example.mongodb.net/mydb?retryWrites=true&w=majority' },
};

test('provider -> env names', () => {
  const names = (id) => n.NATIVE_PROVIDERS[id].env.map((e) => e.name);
  // GitHub's names are override-blocked by OpenClaw and Vercel's env is ignored by
  // the CLI, so neither is delivered through the secret store (see managed.ts).
  assert.deepEqual(names('github-pat'), []);
  assert.deepEqual(names('vercel'), []);
  assert.deepEqual(names('supabase'), ['SUPABASE_ACCESS_TOKEN']);
  assert.deepEqual(names('trello'), ['TRELLO_API_KEY', 'TRELLO_TOKEN']);
  assert.deepEqual(names('notion'), ['NOTION_API_TOKEN']);
  // Never MONGODB_URI: OpenClaw drops that name (and DATABASE_URL, REDIS_URL, AMQP_URL) from its exec tool.
  assert.deepEqual(names('mongodb'), ['REV4A_MONGODB_URI']);
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
  assert.deepEqual(n.storeSetArgv('GH_TOKEN'), gw.gatewayCliArgv(['secrets', 'store', 'set', 'GH_TOKEN', '--kind', 'env', '--value-file', '-']));
  assert.deepEqual(n.storeRemoveArgv('GH_TOKEN'), gw.gatewayCliArgv(['secrets', 'store', 'rm', '--yes', 'GH_TOKEN']));
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
  assert.deepEqual(n.enablePlan('supabase').map((s) => s.kind), ['store-set', 'reload']);
  // GitHub keeps only the skill patch: its token goes through the managed profile.
  assert.deepEqual(n.enablePlan('github-pat').map((s) => s.kind), ['config-patch', 'reload']);
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
  // A provider can raise the floor: Trello's skill needs jq, which entered the image with 2026.9.9.
  assert.ok(n.supportsNative('2026.9.9', '2026.9.9'));
  assert.ok(!n.supportsNative('2026.9.3', '2026.9.9'));
});

test('trello needs 2026.9.9; the others keep the base floor', () => {
  assert.equal(n.NATIVE_PROVIDERS.trello.minVersion, '2026.9.9');
  assert.equal(n.NATIVE_PROVIDERS.mongodb.minVersion, '2026.9.9');
  for (const id of ['github-pat', 'vercel', 'supabase', 'notion']) {
    assert.equal(n.NATIVE_PROVIDERS[id].minVersion, undefined, id);
  }
});

test('trello is refused on an agent without jq (2026.9.3), before writing anything', async () => {
  const exec = fakeExec({ version: 'OpenClaw 2026.9.3 (1391f7c)' });
  await assert.rejects(n.runEnable(exec, 'trello', SECRETS.trello), /needs OpenClaw 2026\.9\.9 or newer/);
  assert.equal(exec.calls.length, 1);
});

test('assertDeliverable (used for vercel and github too) refuses an agent below the floor', async () => {
  const old = fakeExec({ version: 'OpenClaw 2026.8.9 (abc)' });
  await assert.rejects(n.assertDeliverable(old, 'vercel'), /needs OpenClaw 2026\.9\.0 or newer/);
  assert.equal(old.calls.length, 1);
  await n.assertDeliverable(fakeExec({ version: 'OpenClaw 2026.9.3 (1391f7c)' }), 'vercel');
});

// ── failure paths, with the exec primitives injected ─────────────────────────────────

function fakeExec({ failOn = () => false, version = 'OpenClaw 2026.9.9 (bcfc888)', onCall = () => '' } = {}) {
  const calls = [];
  return {
    calls,
    run: async (argv, env, opts) => {
      const call = { argv, env, opts, input: null };
      calls.push(call);
      if (argv[1] === '--version') return version;
      if (failOn(argv)) throw new Error(`exit 1 while running ${argv.join(' ')}`);
      return onCall(call);
    },
    runWithInput: async (argv, input, opts) => {
      const call = { argv, env: undefined, opts, input };
      calls.push(call);
      if (failOn(argv, input)) throw new Error(`patch refused: ${input}`);
      return onCall(call);
    },
  };
}

test('config read-back matches only sent keys, including SecretRefs and plaintext env', () => {
  for (const provider of ['github-pat', 'notion', 'trello', 'mongodb']) {
    const patch = n.enablePatch(provider, SECRETS[provider]);
    const config = structuredClone(patch);
    config.gateway = { port: 3000 };
    const entry = config.skills.entries[n.NATIVE_PROVIDERS[provider].skill.name];
    entry.otherSetting = 'preserved';
    const file = JSON.stringify(config);
    assert.equal(n.configPatchMatches(patch, file), true, provider);
    entry.enabled = false;
    assert.equal(n.configPatchMatches(patch, JSON.stringify(config)), false, provider);
    assert.equal(n.configPatchMatches(patch, '{}'), false, provider);
    assert.equal(JSON.stringify(patch), JSON.stringify(n.enablePatch(provider, SECRETS[provider])), 'no mutation');
  }
  const patch = n.enablePatch('trello', SECRETS.trello);
  const wrongSecret = structuredClone(patch);
  wrongSecret.skills.entries.trello.env.TRELLO_TOKEN = 'old-token';
  assert.equal(n.configPatchMatches(patch, JSON.stringify(wrongSecret)), false);
});

test('config read-back follows merge-patch deletion and array replacement semantics', () => {
  const patch = n.disablePatch('notion');
  for (const config of [{}, { skills: {} }, { skills: { entries: {} } }, { skills: { entries: { github: { enabled: true } } } }]) {
    assert.equal(n.configPatchMatches(patch, JSON.stringify(config)), true);
  }
  for (const value of [null, false, {}, { enabled: true }]) {
    assert.equal(n.configPatchMatches(patch, JSON.stringify({ skills: { entries: { notion: value } } })), false);
  }
  assert.equal(n.configPatchMatches({ list: [{ a: 1 }, null, 2] }, '{"list":[{"a":1},null,2],"other":true}'), true);
  for (const list of [[{ a: 1, b: 2 }, null, 2], [{ a: 1 }, null, 2, 3], [null, { a: 1 }, 2]]) {
    assert.equal(n.configPatchMatches({ list: [{ a: 1 }, null, 2] }, JSON.stringify({ list })), false);
  }
  assert.equal(n.configPatchMatches({ key: {} }, '{}'), false);
  for (const file of ['', '{"skills":', 'null', '[]', 'true', '{"skills":null}', '{"skills":false}']) {
    assert.equal(n.configPatchMatches(patch, file), false, file);
  }
  assert.equal(n.configPatchMatches({ key: false }, '{"key":0}'), false);
  assert.equal(n.configPatchMatches({ key: '1' }, '{"key":1}'), false);
});

test('config comparison matrix accepts a 2 MiB unrelated value without weakening type or deletion checks', () => {
  const patch = { skills: { entries: { github: { enabled: true } } } };
  const checks = {
    extraKeys: n.configPatchMatches(patch, JSON.stringify({ ...patch, unrelated: 'x'.repeat(2 * 1024 * 1024) })),
    missingDeletionAncestor: n.configPatchMatches(n.disablePatch('notion'), '{}'),
    nullStillPresent: n.configPatchMatches(n.disablePatch('notion'), '{"skills":{"entries":{"notion":null}}}'),
    wrongType: n.configPatchMatches({ key: false }, '{"key":0}'),
    reorderedArray: n.configPatchMatches({ list: [1, 2] }, '{"list":[2,1]}'),
    truncatedJson: n.configPatchMatches(patch, '{"skills":'),
    nullRoot: n.configPatchMatches(patch, 'null'),
  };
  assert.deepEqual(checks, { extraKeys: true, missingDeletionAncestor: true, nullStillPresent: false,
    wrongType: false, reorderedArray: false, truncatedJson: false, nullRoot: false });
  console.log(JSON.stringify(checks));
});

test('reload steps get 150 seconds on enable and disable; other steps keep 30 seconds', async () => {
  assert.equal(n.OPENCLAW_RELOAD_TIMEOUT_MS, 150000);
  assert.equal(n.NATIVE_TIMEOUT_MS, 30000);
  for (const disable of [false, true]) {
    const exec = fakeExec();
    if (disable) assert.deepEqual(await n.runDisable(exec, 'trello'), []);
    else await n.runEnable(exec, 'trello', SECRETS.trello);
    for (const c of exec.calls) {
      assert.equal(c.opts?.timeoutMs ?? n.NATIVE_TIMEOUT_MS, c.argv.includes('patch') || c.argv.includes('reload') ? 150000 : 30000);
    }
  }
});

test('slow patch that lands: plain file read confirms it, then reload runs', async () => {
  for (const provider of ['github-pat', 'trello', 'notion', 'mongodb']) {
    const patch = n.enablePatch(provider, SECRETS[provider]);
    const exec = fakeExec({ onCall: ({ argv, opts }) => {
      if (argv.includes('patch')) throw new Error('docker exec timed out or was killed (exit 137) after 150000ms');
      if (argv[0] === 'cat') {
        assert.deepEqual(argv, ['cat', '/root/.openclaw/openclaw.json']);
        assert.equal(opts.timeoutMs, 5000);
        return JSON.stringify(patch);
      }
      return '';
    } });
    await n.runEnable(exec, provider, SECRETS[provider]);
    assert.ok(exec.calls.at(-1).argv.includes('reload'));
    const patches = exec.calls.filter((c) => c.argv.includes('patch'));
    assert.equal(patches.length, 1, 'never resubmit a timed-out patch');
    assert.deepEqual(patches[0].argv, gw.gatewayCliArgv(['config', 'patch', '--stdin']));
    for (const c of exec.calls) for (const value of Object.values(SECRETS[provider])) {
      assert.ok(!JSON.stringify([c.argv, c.env]).includes(value), 'secret stays off argv/env');
    }
  }
});

test('slow patch that does not land, or unreadable config: clear error and no later enable steps', async () => {
  for (const file of ['{}', '{"skills":', new Error('read failed with secret data')]) {
    const exec = fakeExec({ onCall: ({ argv, input }) => {
      if (argv.includes('patch')) throw new Error(`docker exec timed out after 150000ms ${input}`);
      if (argv[0] === 'cat') { if (file instanceof Error) throw file; return file; }
      return '';
    } });
    await assert.rejects(n.runEnable(exec, 'trello', SECRETS.trello), { message: n.CONFIG_PATCH_PENDING_ERROR });
    assert.equal(exec.calls.at(-1).argv[0], 'cat');
    assert.ok(!exec.calls.some((c) => c.argv.includes('reload')));
  }
});

test('ordinary patch failures are redacted and do not trigger read-back', async () => {
  const exec = fakeExec({ failOn: (a) => a.includes('patch') });
  await assert.rejects(n.runEnable(exec, 'trello', SECRETS.trello), /patch refused/);
  assert.ok(!exec.calls.some((c) => c.argv[0] === 'cat'));
});

test('slow disable patch that landed continues; unconfirmed removal still attempts reload and reports failure', async () => {
  for (const file of ['{}', '{"skills":{"entries":{"notion":{"enabled":true}}}}']) {
    const exec = fakeExec({ onCall: ({ argv }) => {
      if (argv.includes('patch')) throw new Error('docker exec agent: timed out');
      if (argv[0] === 'cat') return file;
      return '';
    } });
    const errors = await n.runDisable(exec, 'notion');
    assert.ok(exec.calls.at(-1).argv.includes('reload'));
    assert.deepEqual(errors, file === '{}' ? [] : [`remove the skill entry: ${n.CONFIG_PATCH_PENDING_ERROR}`]);
  }
});

test('a secrets reload timeout reports uncertainty without raw exec output', async () => {
  const exec = fakeExec({ onCall: ({ argv }) => {
    if (argv.includes('reload')) throw new Error('docker exec timed out or was killed (exit 137) after 150000ms');
    return '';
  } });
  await assert.rejects(n.runEnable(exec, 'notion', SECRETS.notion), {
    message: 'The secrets reload could not be confirmed (OpenClaw is slow to reload); try again in a minute.',
  });
  assert.ok(!exec.calls.some((c) => c.argv[0] === 'cat'), 'config read cannot confirm a reload');
});

test('two slow reloads after a long queue keep full deadlines and still read back the patch', async () => {
  let elapsedMs = 300000;
  const exec = fakeExec({ onCall: ({ argv, opts }) => {
    if (argv.includes('patch') || argv.includes('reload')) {
      assert.equal(opts.timeoutMs, 150000);
      elapsedMs += 158000;
    }
    if (argv.includes('patch')) throw new Error('docker exec timed out');
    if (argv[0] === 'cat') return JSON.stringify(n.enablePatch('github-pat', SECRETS['github-pat']));
    return '';
  } });
  await n.runEnable(exec, 'github-pat', SECRETS['github-pat']);
  assert.equal(elapsedMs, 616000);
  assert.ok(exec.calls.at(-1).argv.includes('reload'));
});

test('a failed rm mid-way still attempts every other step', async () => {
  const exec = fakeExec({ failOn: (a) => a.includes('TRELLO_API_KEY') });
  const errors = await n.runDisable(exec, 'trello');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /remove TRELLO_API_KEY/);
  // Show the OpenClaw commands in call order, without their shell wrapper.
  const kinds = exec.calls.map((c) => (c.argv[0] === 'sh' ? ['openclaw', ...c.argv.slice(4)] : c.argv).slice(0, 4).join(' '));
  assert.deepEqual(kinds, [
    'openclaw secrets store rm', 'openclaw secrets store rm',
    'openclaw config patch --stdin', 'openclaw secrets reload',
  ]);
  assert.ok(exec.calls.some((c) => c.argv.includes('TRELLO_TOKEN')), 'the second rm ran');
});

test('every step failing returns every failure, none thrown', async () => {
  const exec = fakeExec({ failOn: () => true });
  const errors = await n.runDisable(exec, 'trello');
  assert.equal(errors.length, 4); // two rm, the patch, the reload
});

test('a clean disable reports no failure', async () => {
  assert.deepEqual(await n.runDisable(fakeExec(), 'notion'), []);
});

test('intent-only and forget requests do not need a running agent', () => {
  assert.equal(requiresContainerWrite({ forget: false, intentOnly: true }), false);
  assert.equal(requiresContainerWrite({ forget: true, intentOnly: false }), false);
  assert.equal(requiresContainerWrite({ forget: false, intentOnly: false }), true);
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
  assert.deepEqual(reload.argv, gw.gatewayCliArgv(['secrets', 'reload'], { port: null }));
  assert.equal(reload.argv[4], 'secrets');
  assert.ok(reload.argv[2].includes('/root/.agent-token'), 'reload must resolve the file token');
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

// lib/credentials/guard.ts: when a user-facing switch is refused (stopped, gone or busy agent).
test('a running idle agent is allowed', () => {
  assert.equal(writeRefusal({ exists: true, running: true, busy: null }), null);
});
test('a stopped agent is refused with the start hint', () => {
  assert.match(writeRefusal({ exists: true, running: false, busy: null }), /^Not running — start the agent/);
});
test('a busy running agent is refused with the reason', () => {
  const m = writeRefusal({ exists: true, running: true, busy: 'An update of this agent is running' });
  assert.match(m, /^Busy: An update of this agent is running — try again when it finishes$/);
});
test('a missing agent is refused', () => {
  assert.match(writeRefusal({ exists: false, running: false, busy: null }), /no longer exists/);
});
test('stopped wins over busy (nothing can be written either way)', () => {
  assert.match(writeRefusal({ exists: true, running: false, busy: 'x' }), /^Not running/);
});
test('the re-apply path never calls the check, the user-facing ones do', () => {
  const src = fs.readFileSync(new URL('../lib/credentials/delivery.ts', import.meta.url), 'utf8');
  const body = (name) => {
    const i = src.indexOf(`export async function ${name}`);
    assert.ok(i >= 0, name);
    const next = src.indexOf('\nexport ', i + 10);
    return src.slice(i, next < 0 ? undefined : next);
  };
  assert.ok(!body('reapplyAssignments').includes('agentWriteRefusal'));
  assert.ok(body('enableAssignment').includes('agentWriteRefusal'));
  assert.ok(body('disableAssignment').includes('agentWriteRefusal'));
});

test('mongodb: skill binding, SecretRef patch, plan, and no value in any argv', () => {
  assert.deepEqual(n.NATIVE_PROVIDERS.mongodb.skill, { name: 'rev4a-mongodb', via: 'apiKey' });
  assert.deepEqual(n.enablePatch('mongodb', SECRETS.mongodb), {
    skills: { entries: { 'rev4a-mongodb': { enabled: true, apiKey: { source: 'store', provider: 'default', id: 'REV4A_MONGODB_URI' } } } },
  });
  assert.ok(!JSON.stringify(n.enablePatch('mongodb', SECRETS.mongodb)).includes('reader'), 'no plaintext in the patch');
  assert.deepEqual(n.enablePlan('mongodb').map((s) => s.kind), ['store-set', 'config-patch', 'reload']);
  assert.deepEqual(n.disablePlan('mongodb').map((s) => s.kind), ['store-rm', 'config-patch', 'reload']);
  assert.deepEqual(n.disablePatch('mongodb'), { skills: { entries: { 'rev4a-mongodb': null } } });
  for (const step of [...n.enablePlan('mongodb'), ...n.disablePlan('mongodb')]) {
    assert.ok(!step.argv.join(' ').includes('reader'));
    assert.ok(!step.argv.includes('MONGODB_URI'));
  }
  // Odd characters survive untouched: trimmed only, never rewritten.
  assert.equal(n.storeInputs('mongodb', { uri: '  ' + SECRETS.mongodb.uri + '\n' })[0].value, SECRETS.mongodb.uri);
});

test('mongodb: refused on 2026.9.8 before anything is written, accepted on 2026.9.9', async () => {
  const old = fakeExec({ version: 'OpenClaw 2026.9.8 (abc)' });
  await assert.rejects(n.runEnable(old, 'mongodb', SECRETS.mongodb), n.UnsupportedNativeVersionError);
  assert.equal(old.calls.length, 1);
  const ok = fakeExec({ version: 'OpenClaw 2026.9.9 (abc)' });
  await n.runEnable(ok, 'mongodb', SECRETS.mongodb);
  const store = ok.calls.find((c) => c.argv.includes('store') && c.argv.includes('set'));
  assert.deepEqual(store.argv, gw.gatewayCliArgv(['secrets', 'store', 'set', 'REV4A_MONGODB_URI', '--kind', 'env', '--value-file', '-']));
  assert.equal(store.input, SECRETS.mongodb.uri, 'the value goes on stdin');
  for (const c of ok.calls) if (c.argv) assert.ok(!c.argv.join(' ').includes(SECRETS.mongodb.uri));
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
