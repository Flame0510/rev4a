#!/usr/bin/env node
/**
 * Tests for lib/docker-stats.js — the parsing, the rate arithmetic and the container sampler
 * behind the System page's per-container consumption. No Docker, no database: the sampler is
 * given a fake Docker. Run it with
 *
 *   node scripts/test-docker-stats.mjs
 *
 * and it exits non-zero on the first failing case. (Not wired into CI: the repo has no test
 * runner yet — see plans for the Playwright work — so this is a script, like check-language.)
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'docker-stats.js'));

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n${e?.stack || e}`);
    process.exit(1);
  }
}

// ── parsing ──────────────────────────────────────────────────────────────────
await test('working set: usage minus inactive_file (cgroup v2)', () => {
  assert.equal(S.workingSetBytes({ usage: 1000, stats: { inactive_file: 300 } }), 700);
});
await test('working set: total_inactive_file (cgroup v1)', () => {
  assert.equal(S.workingSetBytes({ usage: 1000, stats: { total_inactive_file: 400 } }), 600);
});
await test('working set never negative, null when unknown', () => {
  assert.equal(S.workingSetBytes({ usage: 100, stats: { inactive_file: 500 } }), 0);
  assert.equal(S.workingSetBytes({}), null);
});
await test('network and block I/O sums, v1 and v2 op names', () => {
  assert.deepEqual(S.sumNetwork({ a: { rx_bytes: 1, tx_bytes: 2 }, b: { rx_bytes: 10, tx_bytes: 20 } }), { rx: 11, tx: 22 });
  assert.deepEqual(S.sumNetwork(undefined), { rx: null, tx: null });
  assert.deepEqual(S.sumBlockIo({ io_service_bytes_recursive: [{ op: 'read', value: 5 }, { op: 'Write', value: 7 }, { op: 'sync', value: 9 }] }), { rd: 5, wr: 7 });
});
await test('stats without a CPU figure (stopped, just started) give no counters', () => {
  assert.equal(S.readCounters({}, 1), null);
});
await test('cleanName strips control characters and falls back', () => {
  assert.equal(S.cleanName('a\tb\nc', 'x'), 'a b c');
  assert.equal(S.cleanName('  ', 'x'), 'x');
});
await test('primaryName: the name with one leading slash, whatever the order (legacy links)', () => {
  assert.equal(S.primaryName(['/db']), 'db');
  assert.equal(S.primaryName(['/app/db', '/db']), 'db');
  assert.equal(S.primaryName(['/db', '/app/db']), 'db');
  assert.equal(S.primaryName(['/app/db']), '');
  assert.equal(S.primaryName(undefined), '');
});

// ── rates ────────────────────────────────────────────────────────────────────
const c1 = { t: 0, cpuNs: 0, rx: 100, tx: 100, rd: 0, wr: 0 };
const c2 = { t: 10_000, cpuNs: 2e9, rx: 600, tx: 100, rd: 1000, wr: 0 };
await test('rates: 2 CPU-seconds in 10 s is 0.2 cores; bytes per second', () => {
  const r = S.ratesBetween(c1, c2);
  assert.equal(r.cpuCores, 0.2);
  assert.equal(r.rxBps, 50);
  assert.equal(r.txBps, 0);
  assert.equal(r.rdBps, 100);
});
await test('rates: no earlier reading, or a window under a second, is null', () => {
  assert.deepEqual(S.ratesBetween(null, c2), { cpuCores: null, rxBps: null, txBps: null, rdBps: null, wrBps: null });
  assert.equal(S.ratesBetween(c2, { ...c2, t: 10_500 }).cpuCores, null);
});
await test('rates: a counter going backwards is null on its own, the others are kept', () => {
  const r = S.ratesBetween(c2, { t: 20_000, cpuNs: 1e9, rx: 700, tx: 5, rd: 2000, wr: 0 });
  assert.equal(r.cpuCores, null);
  assert.equal(r.txBps, null);
  assert.equal(r.rxBps, 10);
});
await test('rates: a window over the limit is null (a laptop that slept is not a near-zero CPU)', () => {
  const slept = { ...c2, t: 8 * 3600 * 1000, cpuNs: 2e9 + 1e9 };
  assert.ok(S.ratesBetween(c2, slept).cpuCores > 0, 'without a limit it would invent a tiny figure');
  assert.equal(S.ratesBetween(c2, slept, 180).cpuCores, null);
  assert.equal(S.ratesBetween(c1, c2, 180).cpuCores, 0.2);
});

// ── the sampler, against a fake Docker ───────────────────────────────────────
function fakeDocker() {
  const d = {
    clock: 1_000_000_000_000,
    calls: [],
    list: [
      { Id: 'A', Names: ['/agent_a'], Labels: { AGENT_ID: 'agent_a' }, Mounts: [{ Type: 'volume', Name: 'vol-a' }, { Type: 'bind' }] },
      { Id: 'B', Names: ['/registry'], Labels: {}, Mounts: [] },
      { Id: 'C', Names: ['/bad name!'], Labels: {} },
    ],
    stats: { A: { cpu: 0, rx: 0 }, B: { cpu: 0, rx: 0 } },
    failStats: new Set(),
    inspectDelayMs: 0,
  };
  d.request = async (_method, p) => {
    d.calls.push(p);
    if (p === '/containers/json') return d.list;
    if (p === '/info') return { NCPU: 4, MemTotal: 4 * 1024 * 1024 * 1024 };
    const inspect = /^\/containers\/(\w+)\/json$/.exec(p);
    if (inspect) {
      if (d.inspectDelayMs) await new Promise((r) => setTimeout(r, d.inspectDelayMs));
      return { Config: { Env: ['X=1', 'AGENT_NAME=My\tAgent\nTwo'] } };
    }
    const id = /containers\/(\w+)\/stats/.exec(p)?.[1];
    if (d.failStats.has(id)) throw new Error('boom');
    const s = d.stats[id];
    if (!s) return {};
    return {
      cpu_stats: { cpu_usage: { total_usage: s.cpu } },
      memory_stats: { usage: 200 * 1048576, stats: { inactive_file: 100 * 1048576 } },
      pids_stats: { current: 7 },
      networks: { eth0: { rx_bytes: s.rx, tx_bytes: 0 } },
    };
  };
  return d;
}

await test('sampler: the first sample primes (gauges kept, rates null); invalid names skipped; host read', async () => {
  const d = fakeDocker();
  const sampler = S.createContainerSampler({ request: d.request, now: () => d.clock });
  const a = await sampler.sample();
  assert.equal(a.rows.length, 2);
  assert.equal(a.rows[0].cpu_cores, null);
  assert.equal(a.rows[0].mem_mb, 100);
  assert.equal(a.rows[0].pids, 7);
  assert.ok(!a.rows.some((r) => r.container === 'bad name!'));
  assert.deepEqual(a.host, { ncpu: 4, memTotalMb: 4096 });
});
await test('sampler: agent name cleaned, volumes from mounts, non-agents flagged', async () => {
  const d = fakeDocker();
  const a = await S.createContainerSampler({ request: d.request, now: () => d.clock }).sample();
  const src = a.sources.find((x) => x.container === 'agent_a');
  assert.equal(src.name, 'My Agent Two');
  assert.equal(src.volumes, 'vol-a');
  assert.equal(src.is_agent, 1);
  assert.equal(a.sources.find((x) => x.container === 'registry').is_agent, 0);
});
await test('sampler: a container listed under a legacy-link alias is still sampled', async () => {
  const d = fakeDocker();
  d.list = [{ Id: 'B', Names: ['/app/registry', '/registry'], Labels: {}, Mounts: [] }];
  const a = await S.createContainerSampler({ request: d.request, now: () => d.clock }).sample();
  assert.deepEqual(a.rows.map((r) => r.container), ['registry']);
});
await test('sampler: second sample gives the rates; an agent is inspected once', async () => {
  const d = fakeDocker();
  const sampler = S.createContainerSampler({ request: d.request, now: () => d.clock });
  await sampler.sample();
  d.clock += 60_000;
  d.stats.A.cpu = 6e9;
  d.stats.A.rx = 6000;
  const a = await sampler.sample();
  const row = a.rows.find((r) => r.container === 'agent_a');
  assert.equal(row.cpu_cores, 0.1);
  assert.equal(row.net_rx_bps, 100);
  assert.equal(d.calls.filter((p) => p === '/containers/A/json').length, 1);
});
await test('sampler: a counter reset (container restarted) gives no CPU figure, never a spike', async () => {
  const d = fakeDocker();
  const sampler = S.createContainerSampler({ request: d.request, now: () => d.clock });
  await sampler.sample();
  d.clock += 60_000; d.stats.A.cpu = 6e9; await sampler.sample();
  d.clock += 60_000; d.stats.A.cpu = 1e9;
  const a = await sampler.sample();
  assert.equal(a.rows.find((r) => r.container === 'agent_a').cpu_cores, null);
});
await test('sampler: a long gap between passes gives no CPU figure, the next pass does', async () => {
  const d = fakeDocker();
  const sampler = S.createContainerSampler({ request: d.request, now: () => d.clock, maxWindowS: 180 });
  await sampler.sample();
  d.clock += 8 * 3600 * 1000; d.stats.A.cpu = 3e9;
  assert.equal((await sampler.sample()).rows.find((r) => r.container === 'agent_a').cpu_cores, null);
  d.clock += 60_000; d.stats.A.cpu = 9e9;
  assert.equal((await sampler.sample()).rows.find((r) => r.container === 'agent_a').cpu_cores, 0.1);
});
await test('sampler: a stats call that fails skips that container only, and it keeps its counters', async () => {
  const d = fakeDocker();
  const sampler = S.createContainerSampler({ request: d.request, now: () => d.clock });
  await sampler.sample();
  d.clock += 60_000; d.stats.B.cpu = 1e9;
  d.failStats.add('B');
  const failed = await sampler.sample();
  assert.deepEqual(failed.rows.map((r) => r.container), ['agent_a']);
  // The failed container was still seen: it stays on the page (as stopped) instead of vanishing.
  assert.deepEqual(failed.sources.map((r) => r.container), ['agent_a', 'registry']);
  assert.equal(failed.sources.find((r) => r.container === 'registry').name, 'registry');
  d.failStats.delete('B');
  d.clock += 60_000; d.stats.B.cpu = 2e9;
  const back = await sampler.sample();
  // 2 CPU-seconds since the last good reading, 120 s ago: the failed pass did not lose the counters.
  assert.equal(back.rows.find((r) => r.container === 'registry').cpu_cores, 0.0167);
});
await test('sampler: the agent name is fetched beside the stats call, not after it', async () => {
  const d = fakeDocker();
  d.list = Array.from({ length: 4 }, (_, i) => ({ Id: `A${i}`, Names: [`/agent_${i}`], Labels: { AGENT_ID: `agent_${i}` }, Mounts: [] }));
  d.stats = Object.fromEntries(d.list.map((c) => [c.Id, { cpu: 0, rx: 0 }]));
  d.inspectDelayMs = 150;
  const t0 = Date.now();
  await S.createContainerSampler({ request: d.request, now: () => d.clock }).sample();
  assert.ok(Date.now() - t0 < 4 * 150, `4 inspects of 150 ms took ${Date.now() - t0} ms: they ran one after another`);
});
await test('sampler: no containers is an empty pass; Docker down throws', async () => {
  const d = fakeDocker();
  d.list = [];
  assert.equal((await S.createContainerSampler({ request: d.request, now: () => d.clock }).sample()).rows.length, 0);
  await assert.rejects(S.createContainerSampler({ request: async () => { throw new Error('down'); } }).sample(), /down/);
});

// ── /system/df ───────────────────────────────────────────────────────────────
await test('parseStorage: volumes (unused flagged), layers by primary name, images and cache with what nothing uses', () => {
  const df = S.parseStorage({
    LayersSize: 5000,
    Volumes: [
      { Name: 'v-used', UsageData: { Size: 100, RefCount: 1 } },
      { Name: 'v-unused', UsageData: { Size: 700, RefCount: 0 } },
      { Name: 'v-unsized', UsageData: { Size: -1, RefCount: 1 } },
    ],
    Containers: [{ Names: ['/app/agent_a', '/agent_a'], SizeRw: 10 }, { Names: ['/bad name'], SizeRw: 1 }],
    Images: [{ Size: 3000, Containers: 2 }, { Size: 1500, Containers: 0 }],
    BuildCache: [{ Size: 400, InUse: false }, { Size: 50, InUse: true }],
  });
  assert.deepEqual(df.volumes.map((v) => [v.name, v.sizeBytes, v.unused]), [['v-used', 100, false], ['v-unused', 700, true], ['v-unsized', null, false]]);
  assert.deepEqual(df.layers, [{ container: 'agent_a', sizeBytes: 10 }]);
  assert.deepEqual(df.images, { sizeBytes: 5000, reclaimableBytes: 1500 });
  assert.deepEqual(df.buildCache, { sizeBytes: 450, reclaimableBytes: 400 });
});

await test('parseStorage: an error body is not a df answer — null, never zeros', () => {
  assert.equal(S.parseStorage(null), null);
  assert.equal(S.parseStorage({}), null);
  assert.equal(S.parseStorage({ message: 'error processing /system/df' }), null);
});

await test('dockerRequestJson: an HTTP error is not data — error status rejects, valid 200 resolves', async () => {
  const http = (await import('node:http')).default;
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docker-sock-')), 'docker.sock');
  const answers = new Map([
    ['/error.json', [500, '{"message":"boom"}']],
    ['/missing', [404, '{"message":"no such thing"}']],
    ['/good', [200, '{"fine":true}']],
  ]);
  const server = http.createServer((req, res) => {
    const [code, body] = answers.get(req.url) ?? [500, '{}'];
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  // First resolution of the process: the env wins, so the helper talks to this fake.
  process.env.DOCKER_HOST = `unix://${socket}`;
  const { dockerRequestJson } = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'docker-socket-path.js'));
  try {
    await assert.rejects(dockerRequestJson('GET', '/error.json'), /^Error: Docker error 500: \{"message":"boom"\}$/);
    await assert.rejects(dockerRequestJson('GET', '/missing'), /^Error: Docker error 404/);
    assert.deepEqual(await dockerRequestJson('GET', '/good'), { fine: true });
  } finally {
    server.close();
  }
});

console.log(`\n${passed} cases passed`);
