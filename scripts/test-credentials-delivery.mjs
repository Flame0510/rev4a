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
    const state = globalThis.__credentialDeliveryTest;
    state.agentLists++;
    return state.agents ?? [{ container: 'agent-test', agentId: 'test', running: true }];
  }`,
  '@/lib/agent-readiness': `export async function waitForGatewayReady(name, timeout) {
    const state = globalThis.__credentialDeliveryTest;
    state.readinessChecks.push([name, timeout]);
    return state.ready !== false;
  }`,
  '@/lib/rev4a-skills': 'export async function ensureRev4aSkill() {}',
  './vault': `
    const state = () => globalThis.__credentialDeliveryTest;
    export function getSecret(id) { return state().secrets?.[id] ?? { token: 'ghp_offline_test_secret' }; } // secret-ok: fixture
    export function getProfile(id) { return { providerId: state().providers?.[id] ?? 'github-pat' }; }
    export function markSynced(_id, status) { state().status = status; }
    export function markDesynced() { state().status = 'off'; }
  `,
  './assignments': `
    const state = () => globalThis.__credentialDeliveryTest;
    export function getAssignment(id, name) {
      return state().rows ? state().rows.get(name)?.get(id) : state().assignment;
    }
    export function listAllAssignments() {
      state().assignmentLists++;
      if (state().rows) return [...state().rows.entries()].flatMap(([agentId, m]) => [...m.values()].map((r) => ({ ...r, agentId })));
      return state().assignment ? [{ ...state().assignment, agentId: 'agent-test' }] : [];
    }
    export function listLiveForAgent(name) {
      state().reads?.push(name);
      return state().rows ? [...(state().rows.get(name)?.values() ?? [])]
        : state().assignment ? [state().assignment] : [];
    }
    export function recordAssignment(id, name, next) {
      if (state().failRecord && next.ok) throw new Error('fixture persistence error');
      const row = { profileId: id, ...getAssignment(id, name), ...next, pendingRemoval: next.pendingRemoval ?? false,
        syncedAt: next.ok ? 1 : null, lastError: next.ok ? null : next.error };
      if (state().rows) state().rows.get(name).set(id, row);
      else state().assignment = row;
    }
    export function removalRecordState(_current, _held, errors) {
      return { enabled: false, pendingRemoval: errors.length > 0, ok: errors.length === 0, error: errors.join('; ') };
    }
    export function setAssignmentError(_id, _name, error) { state().assignment.error = error; }
    export function supersedeSiblings(id, provider, name) {
      state().superseded?.push([name, id]);
      for (const row of state().rows?.get(name)?.values() ?? []) {
        if (row.profileId !== id && (row.enabled || row.pendingRemoval)
          && (state().providers?.[row.profileId] ?? 'github-pat') === provider) {
          Object.assign(row, { enabled: false, pendingRemoval: false, syncedAt: null, lastError: null });
        }
      }
    }
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
    agentLists: 0, assignmentLists: 0, readinessChecks: [],
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

const mismatch = 'unauthorized: Gateway TOKEN mismatch';
const assignment = (profileId, fields = {}) => ({
  profileId, agentId: 'agent-test', enabled: true, mode: 'env', pendingRemoval: false,
  syncedAt: null, lastError: mismatch, ...fields,
});

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
  await test('startup selection groups mismatch and timeout rows and leaves ambiguous switch-ons alone', () => {
    const first = assignment('first');
    const second = assignment('second');
    const independent = assignment('independent');
    const pending = assignment('pending', { enabled: false, pendingRemoval: true });
    const legacy = assignment('legacy', { lastError: 'docker exec timed out or was killed' });
    const killed = assignment('killed', { lastError: 'docker exec (exit 137)', agentId: 'other-agent' });
    const selected = d.selectCredentialStartupRepairs([
      first, second, independent, pending, legacy, killed,
      assignment('unrelated', { lastError: 'connection refused', agentId: 'ignored' }),
      assignment('disabled', { enabled: false, agentId: 'ignored' }),
      assignment('pending-timeout', { enabled: false, pendingRemoval: true, lastError: 'exit 137', agentId: 'ignored' }),
      assignment('non-native', { agentId: 'ignored' }),
      assignment('non-native-pending', { enabled: false, pendingRemoval: true, agentId: 'ignored' }),
    ], (id) => id === 'legacy' || id.startsWith('non-native') ? 'custom-provider' : 'supabase');
    assert.deepEqual([...selected.keys()], ['agent-test', 'other-agent']);
    assert.deepEqual(selected.get('agent-test'), {
      mismatchedEnables: [first, second, independent], pendingRemovals: [pending], timedOut: [legacy],
    });
    assert.deepEqual(selected.get('other-agent').timedOut, [killed]);
    const providerOf = (id) => id === 'first' || id === 'second' ? 'shared' : id;
    assert.deepEqual(d.selectUnambiguousCredentialEnables([first, second, independent, legacy], providerOf), [independent, legacy]);
    assert.deepEqual(d.selectUnambiguousCredentialEnables([first, legacy], () => 'shared'), []);
  });
  await test('startup repairs token mismatches on running agents and clears taken-over removals without exec', async () => {
    reset();
    state.agents = ['agent-test', 'taken-over', 'stopped'].map((container) => ({
      container, agentId: container, running: container !== 'stopped',
    }));
    state.providers = { enable: 'supabase', remove: 'supabase', replaced: 'supabase', current: 'supabase' };
    state.secrets = { enable: { accessToken: 'fixture-credential' } }; // secret-ok: fixture
    const pending = (id) => assignment(id, { enabled: false, pendingRemoval: true });
    state.rows = new Map([
      ['agent-test', new Map([['enable', assignment('enable')], ['remove', pending('remove')]])],
      ['taken-over', new Map([['replaced', pending('replaced')], ['current', assignment('current', { syncedAt: 1, lastError: null })]])],
      ['stopped', new Map([['stopped', pending('stopped')]])],
    ]);
    const log = console.log;
    const lines = [];
    console.log = (line) => lines.push(line);
    try {
      await d.repairCredentialTimeoutsAtStartup();
      assert.deepEqual(state.readinessChecks, [['agent-test', 120000], ['taken-over', 120000]]);
      const rows = state.rows.get('agent-test');
      assert.equal(rows.get('enable').lastError, null);
      assert.equal(rows.get('remove').pendingRemoval, false);
      assert.equal(state.rows.get('taken-over').get('replaced').pendingRemoval, false);
      assert.equal(state.rows.get('stopped').get('stopped').pendingRemoval, true);
      assert.ok(state.calls.some((c) => c.container === 'agent-test' && c.argv.includes('set')));
      const writes = state.calls.filter((c) => c.argv.includes('rm') || c.argv.includes('set'));
      assert.deepEqual(writes.map((c) => [c.container, c.argv[6]]), [['agent-test', 'rm'], ['agent-test', 'set']]);
      const listed = state.agentLists;
      const calls = state.calls.length;
      state.rows.delete('stopped');
      await d.repairCredentialTimeoutsAtStartup();
      assert.equal(state.assignmentLists, 2, 'one assignment table read per run');
      assert.equal(state.agentLists, listed, 'no Docker listing once there are no repair candidates');
      assert.equal(state.calls.length, calls);
    } finally { console.log = log; }
    assert.deepEqual(lines, [
      '[rev4a] Credentials repaired after a token mismatch: agent-test',
      '[rev4a] Credentials repaired after a token mismatch: taken-over',
    ]);
  });
  await test('a failed sibling switch-on cannot clear a pending removal when neither write succeeds', async () => {
    reset();
    state.providers = { old: 'supabase', replacement: 'supabase' };
    state.secrets = { replacement: { accessToken: 'fixture-credential' } }; // secret-ok: fixture
    const rows = new Map([
      ['old', assignment('old', { enabled: false, pendingRemoval: true })],
      ['replacement', assignment('replacement')],
    ]);
    state.rows = new Map([['agent-test', rows]]);
    const ordinary = state.onExec;
    state.onExec = (call) => {
      if (['rm', 'set', 'patch', 'reload'].some((operation) => call.argv.includes(operation))) throw new Error(mismatch);
      return ordinary(call);
    };
    const warnings = [];
    const warn = console.warn;
    console.warn = (...parts) => warnings.push(parts.join(' '));
    try { await d.repairCredentialTimeoutsAtStartup(); }
    finally { console.warn = warn; }
    const attempts = state.calls.filter((c) => c.argv.includes('rm') || c.argv.includes('set'));
    assert.deepEqual(attempts.map((c) => c.argv[6]), ['rm', 'set']);
    assert.equal(rows.get('old').pendingRemoval, true);
    assert.equal(rows.get('replacement').syncedAt, null);
    assert.deepEqual(warnings, ['[rev4a] Credentials after a token mismatch are still failing: agent-test']);
  });
  await test('startup skips non-native mismatches before listing agents or logging', async () => {
    reset();
    state.providers = { enabled: 'custom-provider', pending: 'custom-provider' };
    state.rows = new Map([['agent-test', new Map([
      ['enabled', assignment('enabled')],
      ['pending', assignment('pending', { enabled: false, pendingRemoval: true })],
    ])]]);
    const warn = console.warn;
    console.warn = () => assert.fail('non-native mismatches must not log a repair warning');
    try { await d.repairCredentialTimeoutsAtStartup(); }
    finally { console.warn = warn; }
    assert.equal(state.assignmentLists, 1);
    assert.equal(state.agentLists, 0);
  });
  await test('startup reports mismatch repair success only when the row is persisted', async () => {
    reset();
    state.providers = { profile: 'supabase' };
    state.secrets = { profile: { accessToken: 'fixture-credential' } }; // secret-ok: fixture
    state.assignment = assignment('profile');
    state.failRecord = true;
    const { log, warn } = console;
    const outcomes = [];
    console.log = (...parts) => outcomes.push(parts.join(' '));
    console.warn = (...parts) => { if (parts[0].startsWith('[rev4a]')) outcomes.push(parts.join(' ')); };
    try { await d.repairCredentialTimeoutsAtStartup(); }
    finally { Object.assign(console, { log, warn }); }
    assert.ok(state.calls.some((c) => c.argv.includes('set')));
    assert.equal(state.assignment.lastError, mismatch);
    assert.deepEqual(outcomes, ['[rev4a] Credentials after a token mismatch are still failing: agent-test']);
  });
  await test('startup retries native removal only after readiness and logs one outcome without exception text', async () => {
    reset();
    state.providers = { profile: 'supabase' };
    state.assignment = assignment('profile', { enabled: false, pendingRemoval: true });
    const warnings = [];
    const warn = console.warn;
    console.warn = (...parts) => warnings.push(parts.join(' '));
    const ordinary = state.onExec;
    state.onExec = (call) => {
      if (call.argv.includes('rm')) throw new Error(mismatch);
      return ordinary(call);
    };
    try {
      state.ready = false;
      await d.repairCredentialTimeoutsAtStartup();
      assert.equal(state.calls.length, 0);
      assert.equal(state.assignment.lastError, mismatch);
      state.ready = true;
      await d.repairCredentialTimeoutsAtStartup();
      assert.ok(state.calls.some((c) => c.argv.includes('rm')));
      assert.equal(state.assignment.pendingRemoval, true);
      state.onExec = ordinary;
      const log = console.log;
      const lines = [];
      console.log = (line) => lines.push(line);
      try { await d.repairCredentialTimeoutsAtStartup(); }
      finally { console.log = log; }
      assert.equal(state.assignment.pendingRemoval, false);
      assert.equal(state.assignment.lastError, null);
      assert.deepEqual(lines, ['[rev4a] Credentials repaired after a token mismatch: agent-test']);
    } finally { console.warn = warn; }
    assert.deepEqual(warnings, Array(2).fill('[rev4a] Credentials after a token mismatch are still failing: agent-test'));
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
  await test('a same-provider mismatch does not block the legacy timeout repair', async () => {
    reset();
    state.superseded = [];
    const rows = new Map([
      ['mismatch', assignment('mismatch')],
      ['timeout', assignment('timeout', { lastError: 'docker exec (exit 137)' })],
    ]);
    state.rows = new Map([['agent-test', rows]]);
    const { log, warn } = console;
    const outcomes = [];
    console.log = console.warn = (line) => outcomes.push(line);
    try { await d.repairCredentialTimeoutsAtStartup(); }
    finally { Object.assign(console, { log, warn }); }
    assert.deepEqual(state.superseded, [['agent-test', 'timeout']]);
    assert.equal(rows.get('timeout').lastError, null);
    assert.equal(rows.get('mismatch').enabled, false, 'only the timeout was delivered');
    assert.deepEqual(outcomes, [
      '[rev4a] Credentials not re-applied on agent-test: two credentials of the same service failed; switch on the one to keep in Credentials',
      '[rev4a] Credentials re-applied after a timeout: agent-test',
    ]);
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
