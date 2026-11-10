#!/usr/bin/env node
/**
 * Tests for lib/credentials/managed.ts: the two providers the OpenClaw secret store
 * cannot carry. Checks stdin RPCs, the legacy fallback, handoff cleanup and base64 file
 * delivery. GitHub PATs never reach exec argv, env or script text; the legacy fallback
 * alone expands params into a container child's argv.
 *
 *   node scripts/test-credentials-managed.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const gw = await import('../lib/gateway-cli.ts');

let passed = 0;
const pending = [];
function test(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function') {
    pending.push(r.then(() => { passed++; console.log(`ok   ${name}`); }, (e) => { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }));
  } else { passed++; console.log(`ok   ${name}`); }
}

const TOKEN = 'ghp_SECRETVALUE1234567890';

function fakeExec(onCall = () => '') {
  const calls = [];
  return {
    calls,
    run: async (argv, env) => { const call = { argv, env: env ?? {} }; calls.push(call); return onCall(call, calls.length); },
    runWithInput: async (argv, input) => { const call = { argv, env: {}, input }; calls.push(call); return onCall(call, calls.length); },
  };
}

function assertNoTokenInExec(calls, token = TOKEN) {
  for (const { argv, env } of calls) {
    for (const value of [...argv, ...Object.keys(env), ...Object.values(env)]) {
      assert.ok(!value.includes(token), 'token in argv, env or script text');
    }
  }
}

// Execute the actual inline Node script offline. A loader supplies a fake public SDK
// (or import error); OpenClaw and Docker are never invoked.
function runRpcScript(script, input, sdkSource, childSource) {
  const loader = `export async function resolve(specifier, context, next) {
    if (specifier === 'openclaw/plugin-sdk/gateway-runtime') {
      return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(sdkSource))}, shortCircuit: true };
    }
    if (specifier === 'node:child_process' && ${childSource !== undefined}) {
      return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(childSource ?? ''))}, shortCircuit: true };
    }
    return next(specifier, context);
  }`;
  const preload = `import { register } from 'node:module'; register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(loader))});`;
  return spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '--input-type=module', '-e', script], {
    input, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:3000', OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token' },
  });
}

test('handoff name matches the OpenClaw schema', () => {
  for (let i = 0; i < 20; i++) assert.match(m.githubHandoffName(), /^github-setup-[a-f0-9]{32}$/);
});

test('github enable: no argv/env carries the token; RPC payloads travel only on stdin', async () => {
  const exec = fakeExec();
  await m.githubEnable(exec, TOKEN);
  assert.equal(exec.calls.length, 2);
  assertNoTokenInExec(exec.calls);
  const { argv, input } = exec.calls[0];
  assert.deepEqual(argv.slice(0, 2), ['sh', '-c']);
  assert.ok(argv[2].startsWith(gw.GATEWAY_TOKEN_SNIPPET + '; '), 'token resolved before the RPCs');
  assert.match(argv[2], /export OPENCLAW_GATEWAY_URL=ws:\/\/127\.0\.0\.1:3000/);
  assert.ok(argv[2].includes('cd "$(dirname "$(readlink -f "$(command -v openclaw)")")"'), 'resolve global package cwd');
  assert.match(argv[2], /exec node --input-type=module -e "\$1"/);
  assert.deepEqual(exec.calls[1].argv, argv, 'both RPCs share the stdin helper');
  const store = JSON.parse(input);
  assert.match(store.params.name, /^github-setup-[a-f0-9]{32}$/);
  assert.match(store.marker, /^REV4A_GITHUB_SDK_UNAVAILABLE_[a-f0-9]{32}$/);
  assert.deepEqual(store, { method: 'secrets.store.set', marker: store.marker, params: {
    name: store.params.name, value: TOKEN, kind: 'secret', allowedHosts: [],
  } });
  const conf = JSON.parse(exec.calls[1].input);
  assert.notEqual(conf.marker, store.marker, 'a fresh marker per call');
  assert.deepEqual(conf, { method: 'tools.github.configure', marker: conf.marker, params: {
    scope: 'agent', agentId: 'main', mode: 'managed', secretName: store.params.name,
  } });
  const result = runRpcScript(argv[4], input, `export async function callGatewayFromCli(method, opts, params) {
    process.stdout.write(JSON.stringify({ method, opts, params }));
  }`);
  assert.equal(result.status, 0, result.stderr);
  const { marker: _m, ...sent } = store;
  assert.deepEqual(JSON.parse(result.stdout), { ...sent, opts: {
    url: 'ws://127.0.0.1:3000', token: 'test-gateway-token', timeout: '15000', json: true,
  } });
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
  assert.ok(argv[2].startsWith('umask 077 &&'), 'auth.json is private from creation');
});

test('vercelConfig carries currentTeam only when a team was found', () => {
  assert.deepEqual(m.vercelConfig('team_ABC'), { currentTeam: 'team_ABC' });
  assert.deepEqual(m.vercelConfig(null), {});
});

test('store and configure failures remove the handoff and redact even JSON-escaped tokens', async () => {
  const token = TOKEN + '"\\\n';
  for (const failedCall of [1, 2]) {
    const exec = fakeExec((call, n) => {
      if (n === failedCall) throw new Error(`RPC refused ${token} ${JSON.stringify(token)}`);
      return '';
    });
    await assert.rejects(m.githubEnable(exec, token), (e) => {
      assert.match(e.message, /RPC refused/);
      assert.ok(!e.message.includes(TOKEN), 'token leaked in the error');
      return true;
    });
    assertNoTokenInExec(exec.calls, TOKEN);
    assert.equal(exec.calls.length, failedCall + 1);
    const name = JSON.parse(exec.calls[0].input).params.name;
    assert.deepEqual(exec.calls.at(-1).argv, ['openclaw', 'secrets', 'store', 'rm', '--yes', name]);
  }
});

test('a failing handoff cleanup does not hide or unredact the enable error', async () => {
  const exec = fakeExec((call) => { throw new Error(`${call.input ? 'gateway refused' : 'cleanup failed'} ${TOKEN}`); });
  await assert.rejects(m.githubEnable(exec, TOKEN), (e) => {
    assert.match(e.message, /gateway refused/);
    assert.ok(!e.message.includes(TOKEN));
    assert.ok(!e.message.includes('cleanup failed'));
    return true;
  });
  assert.equal(exec.calls.length, 2);
  assertNoTokenInExec(exec.calls);
});

test('SDK import unavailability selects legacy fallback with one token-free warning per enable', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    for (const sdk of [
      `throw Object.assign(new Error('no SDK module'), { code: 'ERR_MODULE_NOT_FOUND' });`,
      `throw Object.assign(new Error('SDK path not exported'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });`,
      'export const unrelated = true;',
    ]) {
      const children = [];
      const before = warnings.length;
      const exec = fakeExec((call) => {
        assert.ok(call.input, 'no cleanup on successful fallback');
        const legacy = call.argv[4].includes('spawnSync');
        const result = runRpcScript(call.argv[4], call.input, sdk, legacy ? `
          export function spawnSync(command, args, opts) {
            process.stdout.write(JSON.stringify({ command, args, opts, env: process.env }));
            return { status: 0 };
          }` : undefined);
        assert.equal(result.status, 0, result.stderr);
        if (legacy) children.push(JSON.parse(result.stdout));
        return result.stdout;
      });
      await m.githubEnable(exec, TOKEN);
      assert.equal(exec.calls.length, 3, 'probe once, then two legacy calls');
      assert.equal(warnings.length, before + 1);
      assert.match(warnings.at(-1), /legacy argv fallback/);
      assert.ok(!warnings.at(-1).includes(TOKEN));
      assertNoTokenInExec(exec.calls);
      assert.equal(exec.calls[0].input, exec.calls[1].input, 'same store payload retried');
      assert.equal(children.length, 2);
      for (const [i, child] of children.entries()) {
        const payload = JSON.parse(exec.calls[i + 1].input);
        assert.deepEqual(child.args, ['gateway', 'call', payload.method, '--params', JSON.stringify(payload.params)]);
        assert.equal(child.command, 'openclaw');
        assert.deepEqual(child.opts.stdio, ['ignore', 'ignore', 'inherit']);
        assert.ok(!JSON.stringify(child.env).includes(TOKEN), 'fallback never puts PAT in env');
      }
    }
    const exec = fakeExec((call, n) => {
      if (n === 1) return JSON.parse(call.input).marker;
      if (n === 3) throw new Error(`legacy configure failed ${TOKEN}`);
      return '';
    });
    const before = warnings.length;
    await assert.rejects(m.githubEnable(exec, TOKEN), (e) => {
      assert.match(e.message, /legacy configure failed/);
      assert.ok(!e.message.includes(TOKEN));
      return true;
    });
    assert.equal(warnings.length, before + 1);
    assert.equal(exec.calls.length, 4);
    const name = JSON.parse(exec.calls[0].input).params.name;
    assert.deepEqual(exec.calls.at(-1).argv, ['openclaw', 'secrets', 'store', 'rm', '--yes', name]);
    assertNoTokenInExec(exec.calls);
  } finally {
    console.warn = originalWarn;
  }
});

test('output that is not this call\'s marker never selects the fallback', async () => {
  const exec = fakeExec(() => 'noise REV4A_GITHUB_GATEWAY_SDK_UNAVAILABLE REV4A_GITHUB_SDK_UNAVAILABLE_' + '0'.repeat(32));
  await m.githubEnable(exec, TOKEN);
  assert.equal(exec.calls.length, 2, 'no legacy calls');
  assert.ok(exec.calls.every((c) => !c.argv[4].includes('spawnSync')));
});

test('an SDK error is masked inside the container, whole, with exit code 1', async () => {
  const exec = fakeExec();
  await m.githubEnable(exec, TOKEN);
  const { argv, input } = exec.calls[0];
  const result = runRpcScript(argv[4], input, `export async function callGatewayFromCli(method, opts, params) {
    throw new Error('bad credential ' + params.value + ' ' + 'x'.repeat(200000) + ' end');
  }`);
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes(TOKEN), 'token left the container');
  assert.match(result.stderr, /^Gateway call failed: bad credential \*\*\* x+ end$/);
});

test('SDK runtime failures and unrelated import errors never select the argv fallback', async () => {
  for (const sdk of [
    `export async function callGatewayFromCli(method, opts, params) {
      throw Object.assign(new Error('RPC failed ' + (params.value ?? '')), { code: 'ERR_MODULE_NOT_FOUND' });
    }`,
    `throw new Error('module initialization failed');`,
    'invalid javascript source !',
  ]) {
    const exec = fakeExec((call) => {
      if (!call.input) return '';
      assert.ok(!call.argv[4].includes('spawnSync'), 'unexpected legacy fallback');
      const result = runRpcScript(call.argv[4], call.input, sdk);
      assert.notEqual(result.status, 0);
      throw new Error(result.stderr);
    });
    await assert.rejects(m.githubEnable(exec, TOKEN), (e) => { assert.ok(!e.message.includes(TOKEN)); return true; });
    assert.equal(exec.calls.length, 2, 'failed SDK call and handoff cleanup only');
    assertNoTokenInExec(exec.calls);
  }
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

test('github disable sweeps handoffs even when configure fails', async () => {
  const calls = [];
  const exec = { run: async (argv) => { calls.push(argv); if (calls.length === 1) throw new Error('configure failed'); return ''; }, runWithInput: async () => '' };
  await assert.rejects(m.githubDisable(exec), /configure failed/);
  assert.equal(calls.length, 2);
  assert.match(calls[1][2], /secrets store list/);
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
