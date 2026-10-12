#!/usr/bin/env node
/**
 * Tests for lib/credentials/managed.ts: the two providers the OpenClaw secret store
 * cannot carry. Checks the RPC shapes, the handoff name, the base64 file delivery, and
 * that the secret never reaches the argv or the script text.
 *
 *   node scripts/test-credentials-managed.mjs
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// managed.ts imports native.ts without an extension, as Next resolves it; a small resolve
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
const m = await import('../lib/credentials/managed.ts');

let passed = 0;
const pending = [];
function test(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function') {
    pending.push(r.then(() => { passed++; console.log(`ok   ${name}`); }, (e) => { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }));
  } else { passed++; console.log(`ok   ${name}`); }
}

const TOKEN = 'ghp_SECRETVALUE1234567890';

function fakeExec() {
  const calls = [];
  return {
    calls,
    run: async (argv, env) => { calls.push({ argv, env: env ?? {} }); return ''; },
    runWithInput: async (argv, input) => { calls.push({ argv, env: {}, input }); return ''; },
  };
}

test('handoff name matches the OpenClaw schema', () => {
  for (let i = 0; i < 20; i++) assert.match(m.githubHandoffName(), /^github-setup-[a-f0-9]{32}$/);
});

test('github enable calls the two RPCs; the token is only in the env', async () => {
  const exec = fakeExec();
  await m.githubEnable(exec, TOKEN);
  assert.equal(exec.calls.length, 1);
  const { argv, env } = exec.calls[0];
  assert.deepEqual(argv.slice(0, 2), ['sh', '-c']);
  const script = argv[2];
  assert.match(script, /openclaw gateway call secrets\.store\.set --params "\$REV4A_STORE_PARAMS"/);
  assert.match(script, /openclaw gateway call tools\.github\.configure --params "\$REV4A_CONF_PARAMS"/);
  // The secret is nowhere in the argv / script text.
  assert.ok(!JSON.stringify(argv).includes(TOKEN), 'token in argv');
  // ...only inside the JSON handed to docker through its own environment.
  assert.equal(JSON.parse(env.REV4A_STORE_PARAMS).value, TOKEN);
  assert.equal(env.OPENCLAW_GATEWAY_URL, 'ws://127.0.0.1:3000');
  const conf = JSON.parse(env.REV4A_CONF_PARAMS);
  assert.equal(conf.mode, 'managed');
  assert.equal(conf.agentId, 'main');
  assert.equal(conf.secretName, JSON.parse(env.REV4A_STORE_PARAMS).name);
});

test('github disable asks OpenClaw to inherit again', async () => {
  const exec = fakeExec();
  await m.githubDisable(exec);
  const { argv, env } = exec.calls[0];
  assert.ok(!JSON.stringify(argv).includes('managed'));
  assert.equal(JSON.parse(env.REV4A_CONF_PARAMS).mode, 'inherit');
});

test('vercel enable writes base64 files; the token is only in the env', async () => {
  const exec = fakeExec();
  await m.vercelEnable(exec, TOKEN, 'team_ABC');
  const { argv, env } = exec.calls[0];
  assert.ok(!JSON.stringify(argv).includes(TOKEN), 'token in argv or script text');
  assert.equal(JSON.parse(Buffer.from(env.REV4A_VERCEL_AUTH, 'base64').toString()).token, TOKEN);
  assert.equal(JSON.parse(Buffer.from(env.REV4A_VERCEL_CONF, 'base64').toString()).currentTeam, 'team_ABC');
  assert.match(env.REV4A_VERCEL_AUTH, /^[A-Za-z0-9+/=]+$/); // base64 only
});

test('vercel enable without a team still writes config.json, without currentTeam', async () => {
  const exec = fakeExec();
  await m.vercelEnable(exec, TOKEN, null);
  const { argv, env } = exec.calls[0];
  // A currentTeam left by an earlier delivery must not survive into this one.
  assert.ok(argv[2].includes('config.json'), 'config.json is always written');
  const conf = JSON.parse(Buffer.from(env.REV4A_VERCEL_CONF, 'base64').toString());
  assert.ok(!('currentTeam' in conf), 'no stale currentTeam');
  assert.ok(!JSON.stringify(argv).includes(TOKEN), 'token in argv or script text');
});

test('vercelConfig carries currentTeam only when a team was found', () => {
  assert.deepEqual(m.vercelConfig('team_ABC'), { currentTeam: 'team_ABC' });
  assert.deepEqual(m.vercelConfig(null), {});
});

test('a github enable error never carries the token', async () => {
  const exec = { run: async () => { throw new Error('exit 1 — gateway refused ghp_SECRETVALUE1234567890'); }, runWithInput: async () => '' };
  await assert.rejects(m.githubEnable(exec, TOKEN), (e) => {
    assert.ok(!e.message.includes(TOKEN), 'token leaked in the error');
    return true;
  });
});

test('a failed github enable removes its handoff entry, then reports the error without the token', async () => {
  const calls = [];
  const exec = {
    run: async (argv, env) => {
      calls.push({ argv, env: env ?? {} });
      if (argv[0] === 'sh') throw new Error('configure failed for ghp_SECRETVALUE1234567890');
      return '';
    },
    runWithInput: async () => '',
  };
  await assert.rejects(m.githubEnable(exec, TOKEN), (e) => { assert.ok(!e.message.includes(TOKEN)); return true; });
  assert.equal(calls.length, 2);
  const name = JSON.parse(calls[0].env.REV4A_STORE_PARAMS).name;
  assert.deepEqual(calls[1].argv, ['openclaw', 'secrets', 'store', 'rm', '--yes', name]);
});

test('a failing handoff cleanup does not hide the enable error', async () => {
  const exec = { run: async () => { throw new Error('gateway refused'); }, runWithInput: async () => '' };
  await assert.rejects(m.githubEnable(exec, TOKEN), /gateway refused/);
});

test('github disable also sweeps leftover handoffs, keeping only exact github-setup-<hex> names', async () => {
  const exec = fakeExec();
  await m.githubDisable(exec);
  assert.equal(exec.calls.length, 2);
  const sweep = exec.calls[1].argv[2];
  assert.match(sweep, /secrets store list/);
  assert.match(sweep, /github-setup-\[a-f0-9\]\\\{32\\\}/);
  assert.match(sweep, /secrets store rm --yes "\$n"/);
  assert.ok(sweep.endsWith('exit 0'), 'the sweep never fails the disable');
});

test('a failing sweep does not fail the disable', async () => {
  let n = 0;
  const exec = { run: async () => { if (n++ === 1) throw new Error('list failed'); return ''; }, runWithInput: async () => '' };
  await m.githubDisable(exec);
});

test('removeStoreEntries runs one rm per name with --yes', async () => {
  const exec = fakeExec();
  await m.removeStoreEntries(exec, ['GH_TOKEN', 'GITHUB_TOKEN']);
  assert.deepEqual(exec.calls.map((c) => c.argv), [
    ['openclaw', 'secrets', 'store', 'rm', '--yes', 'GH_TOKEN'],
    ['openclaw', 'secrets', 'store', 'rm', '--yes', 'GITHUB_TOKEN'],
  ]);
});

// The detect probe parser has its own file; run it with this suite (package.json lists three files).
await import('./test-credentials-detect.mjs');
// So does the intent-only switch-off (its own throw-away data directory).
await import('./test-credentials-intent.mjs');

await Promise.all(pending);
console.log(`\n${passed} passed`);
