#!/usr/bin/env node
/** Delivery orchestration with fake Docker/vault boundaries. No network, Docker, or SSH. */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const stubs = {
  '@/lib/docker-exec': `
    const state = () => globalThis.__credentialDeliveryTest;
    export async function dockerExec(container, argv, opts) {
      const call = { container, argv, opts }; state().calls.push(call);
      return state().onExec(call);
    }
    export async function dockerExecWithInput(container, argv, input, opts) {
      const call = { container, argv, input, opts }; state().calls.push(call);
      return state().onExec(call);
    }
    export async function mapWithConcurrency(items, _limit, fn) { return Promise.all(items.map(fn)); }
  `,
  '@/lib/agent-busy': 'export async function agentBusyReason() { return null; }',
  '@/lib/subscriptions': `export async function listAgentContainers() {
    return globalThis.__credentialDeliveryTest.agents ?? [{ container: 'agent-test', agentId: 'test', running: true }];
  }`,
  '@/lib/agent-readiness': 'export async function waitForGatewayReady() { return globalThis.__credentialDeliveryTest?.ready !== false; }',
  '@/lib/rev4a-skills': 'export async function ensureRev4aSkill() {}',
  './vault': `
    const state = () => globalThis.__credentialDeliveryTest;
    export function getSecret() { return { token: 'ghp_offline_test_secret' }; }
    export function getProfile() { return { providerId: 'github-pat' }; }
    export function markSynced(_id, status) { state().status = status; }
    export function markDesynced() { state().status = 'off'; }
  `,
  './assignments': `
    const state = () => globalThis.__credentialDeliveryTest;
    export function getAssignment(id, name) {
      return state().rows ? state().rows.get(name)?.get(id) : state().assignment;
    }
    export function listAllAssignments() {
      if (state().rows) return [...state().rows.entries()].flatMap(([agentId, m]) => [...m.values()].map((r) => ({ agentId, ...r })));
      return state().assignment ? [{ agentId: 'agent-test', ...state().assignment }] : [];
    }
    export function listLiveForAgent(name) {
      state().reads?.push(name);
      return state().rows ? [...(state().rows.get(name)?.values() ?? [])]
        : state().assignment ? [state().assignment] : [];
    }
    export function recordAssignment(id, name, next) {
      const row = { profileId: id, ...getAssignment(id, name), ...next, lastError: next.ok ? null : next.error };
      if (state().rows) state().rows.get(name).set(id, row);
      else state().assignment = row;
    }
    export function removalRecordState(_current, _held, errors) {
      return { enabled: false, pendingRemoval: errors.length > 0, ok: errors.length === 0, error: errors.join('; ') };
    }
    export function setAssignmentError(_id, _name, error) { state().assignment.error = error; }
    export function supersedeSiblings(id, _provider, name) { state().superseded?.push([name, id]); }
  `,
  './providers': 'export function getProvider() { return {}; }',
  './detect': 'export async function listAgentContainers() { return []; }',
};
const lockUrl = new URL('../lib/agent-config-lock.ts', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync } from 'node:fs';
  import { pathToFileURL } from 'node:url';
  const stubs = ${JSON.stringify(stubs)};
  export async function resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/credentials/delivery.ts') && stubs[specifier]) {
      return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
    }
    if (specifier === '@/lib/docker-socket') return { url: 'data:text/javascript,export function resolveDockerSocket() { throw new Error("Real Docker forbidden in offline tests"); }', shortCircuit: true };
    if (specifier === '@/lib/agent-config-lock') return next(${JSON.stringify(lockUrl)}, context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\\.\\w+$/.test(specifier)) {
      const p = new URL(specifier, context.parentURL).pathname + '.ts';
      if (existsSync(p)) return next(pathToFileURL(p).href, context);
      const js = new URL(specifier, context.parentURL).pathname + '.js';
      if (existsSync(js)) return next(pathToFileURL(js).href, context);
    }
    return next(specifier, context);
  }
`), pathToFileURL(import.meta.dirname + '/'));

const d = await import('../lib/credentials/delivery.ts');
const n = await import('../lib/credentials/native.ts');
const { withAgentConfigLock } = await import('../lib/agent-config-lock.ts');
const { runWithWrapperFallback } = await import('../lib/docker-exec.ts');
let passed = 0;
let state;
let clock = 0;
const realPerformance = globalThis.performance;
globalThis.performance = { now: () => clock };

function reset({ lands = true, failReload = false, slow = false } = {}) {
  clock = 0;
  state = globalThis.__credentialDeliveryTest = {
    calls: [], assignment: null, config: '{}', status: null,
    onExec: ({ argv, input, opts }) => {
      if (argv[1] === '--version') return 'OpenClaw 2026.10.10';
      if (argv.includes('patch')) {
        assert.equal(opts.timeoutMs, 150000);
        if (lands) state.config = input.includes(':null') ? '{}' : input;
        if (slow) clock += 158000;
        throw new Error('docker exec timed out or was killed (exit 137) after 150000ms');
      }
      if (argv[0] === 'cat') return state.config;
      if (argv.includes('reload') && failReload) throw new Error('docker exec timed out');
      if (argv[0] === 'sh' && argv[2].startsWith('cat ')) return '\x04';
      return '';
    },
  };
}
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok   ${name}`);
}

try {
  await test('switch-on confirms a slow patch, delivers GitHub, and records success', async () => {
    reset({ slow: true });
    assert.equal((await d.enableAssignment('profile', 'agent-test')).status, 'ok');
    assert.equal(state.assignment.ok, true);
    assert.equal(state.status, 'active');
    assert.deepEqual(state.calls.filter((c) => c.input?.includes('"method"')).map((c) => JSON.parse(c.input).method),
      ['secrets.store.set', 'tools.github.configure']);
    assert.equal(state.calls.find((c) => c.argv.includes('reload')).opts.timeoutMs, 150000);
    assert.equal(state.calls.find((c) => c.argv.includes('GH_TOKEN')).opts.timeoutMs, 30000);
    for (const c of state.calls) assert.ok(!JSON.stringify([c.argv, c.opts]).includes('ghp_offline_test_secret'));
  });
  await test('unconfirmed patch persists the clear error and skips managed delivery', async () => {
    reset({ lands: false });
    const result = await d.enableAssignment('profile', 'agent-test');
    assert.equal(result.error, n.CONFIG_PATCH_PENDING_ERROR);
    assert.equal(state.assignment.error, result.error);
    assert.equal(state.assignment.enabled, true, 'intent survives for a later consistency pass');
    assert.ok(!state.calls.some((c) => c.input?.includes('"method"')));
  });
  await test('consistency pass repairs a failed enabled assignment using the same recovery', async () => {
    reset();
    state.assignment = { profileId: 'profile', enabled: true, mode: 'env', ok: false, error: 'old timeout' };
    await d.reapplyAssignments('agent-test');
    assert.equal(state.assignment.ok, true);
    assert.ok(state.calls.some((c) => c.input?.includes('tools.github.configure')));
  });
  await test('GitHub switch-off preserves native reload failures as pending removal', async () => {
    reset({ failReload: true });
    state.assignment = { enabled: true };
    const result = await d.disableAssignment('profile', 'agent-test');
    assert.equal(result.status, 'error');
    assert.match(result.error, /reload could not be confirmed/);
    assert.equal(state.assignment.pendingRemoval, true);
  });
  await test('queued enable and disable wait beyond the removed budget and execute only after lock release', async () => {
    for (const holdMs of [269999, 270000, 270001]) for (const disable of [false, true]) {
      reset();
      state.assignment = { profileId: 'profile', enabled: true, mode: 'env' };
      let release;
      let entered;
      const ready = new Promise((resolve) => { entered = resolve; });
      const holder = withAgentConfigLock('agent-test', async () => {
        entered();
        await new Promise((resolve) => { release = resolve; });
      });
      await ready;
      let settled = false;
      const change = (disable ? d.disableAssignment('profile', 'agent-test') : d.enableAssignment('profile', 'agent-test'))
        .then((result) => { settled = true; return result; });
      clock = holdMs;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(state.calls.length, 0);
      release();
      await holder;
      assert.equal((await change).status, 'ok');
      assert.ok(state.calls.length > 0);
    }
    console.log('queue holds 269999/270000/270001ms: enable + disable waited, then succeeded');
  });
  await test('wrapper fallback finishes its old write before the next config-lock writer commits', async () => {
    reset();
    let releaseRetry;
    let retryEntered;
    let value;
    const events = [];
    const ready = new Promise((resolve) => { retryEntered = resolve; });
    const pendingRetry = new Promise((resolve) => { releaseRetry = resolve; });
    const ordinary = state.onExec;
    state.onExec = async (call) => {
      if (!call.argv.includes('patch')) return ordinary(call);
      return runWithWrapperFallback('agent-test', async (wrapped) => {
        if (wrapped) throw Object.assign(new Error('no timeout binary'), { wrapperMissing: true });
        clock = 98999;
        events.push('unwrapped retry started at ' + clock);
        retryEntered();
        await pendingRetry;
        value = 'OLD credential';
        events.push('unwrapped retry committed OLD credential at ' + clock);
        return '';
      }, async () => ({ code: 127, output: 'timeout: not found' }), new Set());
    };
    const first = d.enableAssignment('profile', 'agent-test');
    await ready;
    let secondStarted = false;
    const second = withAgentConfigLock('agent-test', async () => {
      secondStarted = true;
      value = 'NEW credential';
      events.push('second writer committed NEW credential at ' + clock);
    });
    clock = 100000;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondStarted, false, 'lock still held while fallback can write');
    clock = 101000;
    releaseRetry();
    assert.equal((await first).status, 'ok');
    await second;
    assert.equal(value, 'NEW credential');
    console.log(JSON.stringify({ events, finalValue: value }));
  });
  await test('startup selects running agents with enabled legacy timeout errors, sequentially and idempotently', async () => {
    reset();
    state.agents = ['old-kill', 'exit-137', 'healthy', 'disabled', 'stopped'].map((name) => ({
      container: name, agentId: name, running: name !== 'stopped',
    }));
    state.reads = [];
    const row = (id, enabled, lastError) => ({ profileId: id, enabled, mode: 'env', lastError });
    state.rows = new Map([
      ['old-kill', new Map([['p1', row('p1', true, 'docker exec timed out or was killed after 30000ms')]])],
      ['exit-137', new Map([['p2', row('p2', true, 'docker exec (exit 137)')]])],
      ['healthy', new Map(Array.from({ length: 100000 }, (_, i) => ['h' + i, row('h' + i, true, i % 2 ? null : 'different error')]))],
      ['disabled', new Map([['d', row('d', false, 'exit 137')]])],
      ['stopped', new Map([['s', row('s', true, 'timed out or was killed')]])],
    ]);
    const log = console.log;
    const lines = [];
    console.log = (line) => lines.push(line);
    let active = 0;
    let maxActive = 0;
    const ordinary = state.onExec;
    state.onExec = async (call) => {
      active++;
      maxActive = Math.max(active, maxActive);
      try { await new Promise((resolve) => setImmediate(resolve)); return ordinary(call); }
      finally { active--; }
    };
    try {
      await d.repairCredentialTimeoutsAtStartup();
      assert.deepEqual([...new Set(state.calls.map((c) => c.container))], ['old-kill', 'exit-137']);
      assert.equal(maxActive, 1);
      assert.ok(!state.reads.includes('stopped'));
      const count = state.calls.length;
      await d.repairCredentialTimeoutsAtStartup();
      assert.equal(state.calls.length, count, 'cleared errors do not trigger a second repair');
      assert.equal(lines.length, 2, 'one success line per repaired agent');
      assert.equal(state.rows.get('old-kill').get('p1').lastError, null);
      assert.equal(state.rows.get('exit-137').get('p2').lastError, null);
    } finally { console.log = log; }
    console.log(JSON.stringify({ unrelatedRows: 100000, repaired: ['old-kill', 'exit-137'], maxActive, secondStartExecs: 0, lines }));
  });
  await test('startup repairs only the timed-out switch-on, which supersedes the older credential', async () => {
    reset();
    state.agents = [{ container: 'conflict', agentId: 'conflict', running: true }];
    state.superseded = [];
    const row = (id, lastError) => ({ profileId: id, enabled: true, mode: 'env', lastError });
    // Table order puts the healthy credential last: a full re-apply would leave it delivered.
    state.rows = new Map([['conflict', new Map([
      ['failed', row('failed', 'docker exec timed out or was killed (exit 137) after 30000ms')],
      ['healthy', row('healthy', null)],
    ])]]);
    const log = console.log;
    console.log = () => {};
    try { await d.repairCredentialTimeoutsAtStartup(); }
    finally { console.log = log; }
    assert.deepEqual(state.superseded, [['conflict', 'failed']], 'only the timed-out switch-on is delivered, then supersedes');
    assert.equal(state.rows.get('conflict').get('failed').lastError, null);
  });
  await test('startup leaves two timed-out credentials of one service alone, and waits for the Gateway', async () => {
    const timeout = 'docker exec timed out or was killed (exit 137) after 30000ms';
    const row = (id) => ({ profileId: id, enabled: true, mode: 'env', lastError: timeout });
    const warn = console.warn;
    const warnings = [];
    console.warn = (...parts) => warnings.push(parts.join(' '));
    try {
      reset();
      state.agents = [{ container: 'twice', agentId: 'twice', running: true }];
      state.rows = new Map([['twice', new Map([['a', row('a')], ['z', row('z')]])]]);
      await d.repairCredentialTimeoutsAtStartup();
      assert.equal(state.calls.length, 0, 'neither sibling delivered');
      assert.equal(state.rows.get('twice').get('a').lastError, timeout);
      assert.equal(state.rows.get('twice').get('z').lastError, timeout);
      assert.ok(warnings.some((w) => w.includes('two credentials of the same service')));
      reset();
      state.ready = false;
      state.agents = [{ container: 'starting', agentId: 'starting', running: true }];
      state.rows = new Map([['starting', new Map([['p', row('p')]])]]);
      await d.repairCredentialTimeoutsAtStartup();
      assert.equal(state.calls.length, 0, 'nothing runs before the Gateway is ready');
      assert.equal(state.rows.get('starting').get('p').lastError, timeout, 'still eligible at the next start');
      assert.ok(warnings.some((w) => w.includes('Gateway not ready')));
    } finally { console.warn = warn; }
  });
  await test('startup logs a failed re-apply instead of reporting swallowed errors as success', async () => {
    reset({ lands: false });
    state.assignment = { profileId: 'profile', enabled: true, mode: 'env', lastError: 'exit 137' };
    const warn = console.warn;
    const warnings = [];
    console.warn = (...parts) => warnings.push(parts.join(' '));
    try { await d.repairCredentialTimeoutsAtStartup(); }
    finally { console.warn = warn; }
    assert.equal(state.assignment.lastError, n.CONFIG_PATCH_PENDING_ERROR);
    assert.ok(warnings.includes('[rev4a] Credentials re-apply after a timeout failed: agent-test'));
    assert.ok(warnings.every((line) => !line.includes('ghp_offline_test_secret')));
  });
  await test('intent-only removal makes no execs and refuses pending removal', async () => {
    for (const pendingRemoval of [false, true]) {
      reset();
      state.assignment = { enabled: true, pendingRemoval };
      assert.equal((await d.disableAssignment('profile', 'agent-test', { intentOnly: true })).status, pendingRemoval ? 'error' : 'ok');
      assert.equal(state.calls.length, 0);
    }
  });
  await test('older OpenClaw refuses delivery before recording any new assignment', async () => {
    reset();
    state.onExec = () => 'OpenClaw 2026.8.9';
    assert.equal((await d.enableAssignment('profile', 'agent-test')).status, 'error');
    assert.equal(state.calls.length, 1);
    assert.equal(state.assignment, null);
  });
  await test('incomplete legacy reads never write; complete blocks preserve unrelated content', async () => {
    const block = 'prefix\n<!-- REV4A:INTEGRATIONS:START -->\n| \x60gh\x60 | ready | old |\n<!-- REV4A:INTEGRATIONS:END -->\nsuffix';
    for (const content of ['partial', 'x'.repeat(524288), block + '\x04']) {
      reset();
      const ordinary = state.onExec;
      state.onExec = (call) => {
        if (call.argv[0] === 'sh' && call.argv[2].startsWith('cat ')) {
          assert.equal(call.opts.maxBuffer, 524288);
          return content;
        }
        return ordinary(call);
      };
      const result = await d.enableAssignment('profile', 'agent-test');
      assert.equal(result.status, 'ok');
      const writes = state.calls.filter((c) => c.argv[0] === 'sh' && c.argv[2].includes('base64 -d'));
      if (!content.endsWith('\x04')) {
        assert.equal(writes.length, 0);
        assert.match(result.warning, /TOOLS.md row/);
      } else {
        assert.equal(writes.length, 1);
        const encoded = JSON.parse(writes[0].argv[2].match(/^echo ("[^"]+")/)[1]);
        assert.equal(Buffer.from(encoded, 'base64').toString(), 'prefix\n\nsuffix');
      }
    }
  });
} finally {
  globalThis.performance = realPerformance;
  delete globalThis.__credentialDeliveryTest;
}
console.log(`\n${passed} passed`);
