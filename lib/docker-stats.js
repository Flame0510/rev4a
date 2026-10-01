'use strict';

/**
 * What each container consumes, from the Docker Engine API — the parsing and the rate
 * arithmetic, free of any database or timer so it can be tested on its own. daemon.js
 * owns the timers and the tables (metrics.db); this module turns Docker's answers into
 * rows.
 *
 * Plain CommonJS for the same reason as lib/docker-socket-path.js: the daemon requires it.
 *
 * Why the raw API and not `docker stats`: `GET /containers/{id}/stats?one-shot=true`
 * answers in 10–20 ms with cumulative counters (CPU time in ns, network and block bytes),
 * while `docker stats --no-stream` waits a second per container for a second sample and
 * hands back formatted strings. Two samples of the daemon's own timer give the CPU
 * share over a real window.
 */

/** A Docker container name, as `docker ps` prints it; anything else is never used. */
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const REQUEST_TIMEOUT_MS = 10_000;
const DF_TIMEOUT_MS = 60_000;
/** `docker info` (cores, memory) changes only when Docker Desktop is reconfigured. */
const HOST_TTL_MS = 10 * 60_000;
/** Two samples closer than this give a rate dominated by timing noise. */
const MIN_WINDOW_S = 1;
const MB = 1024 * 1024;

/**
 * The container's own name from Docker's `Names`: the one with a single leading slash.
 * A container that is the target of a legacy link also carries `/other/alias` entries, and
 * nothing promises which comes first — taking the first blindly would drop it, silently.
 */
function primaryName(names) {
  const own = (Array.isArray(names) ? names : []).find((n) => typeof n === 'string' && /^\/[^/]+$/.test(n));
  return own ? own.slice(1) : '';
}

/** A display name without control characters (a tab or a newline in a name), bounded. */
function cleanName(value, fallback = null) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Working-set memory: usage minus the inactive page cache, what `docker stats` shows (and
 * what the kernel will not give back under pressure). cgroup v2 names it `inactive_file`,
 * v1 `total_inactive_file`.
 */
function workingSetBytes(memory) {
  const usage = memory?.usage;
  if (!finite(usage)) return null;
  const inactive = memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0;
  return Math.max(0, usage - (finite(inactive) ? inactive : 0));
}

/** Bytes received and sent, summed over the container's networks. */
function sumNetwork(networks) {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const n of Object.values(networks || {})) {
    if (finite(n?.rx_bytes)) { rx += n.rx_bytes; seen = true; }
    if (finite(n?.tx_bytes)) { tx += n.tx_bytes; seen = true; }
  }
  return seen ? { rx, tx } : { rx: null, tx: null };
}

/** Bytes read and written on block devices (`op` is `read`/`write` on v2, `Read`/`Write` on v1). */
function sumBlockIo(blkio) {
  let rd = 0;
  let wr = 0;
  let seen = false;
  for (const e of blkio?.io_service_bytes_recursive || []) {
    if (!finite(e?.value)) continue;
    const op = String(e.op || '').toLowerCase();
    if (op === 'read') { rd += e.value; seen = true; }
    else if (op === 'write') { wr += e.value; seen = true; }
  }
  return seen ? { rd, wr } : { rd: null, wr: null };
}

/**
 * One stats answer as counters, or null when it holds no CPU figure (a stopped container, or
 * one that has only just started, answers an empty object).
 */
function readCounters(stats, atMs) {
  const cpuNs = stats?.cpu_stats?.cpu_usage?.total_usage;
  if (!finite(cpuNs)) return null;
  const net = sumNetwork(stats.networks);
  const blk = sumBlockIo(stats.blkio_stats);
  return {
    t: atMs,
    cpuNs,
    memBytes: workingSetBytes(stats.memory_stats),
    pids: finite(stats.pids_stats?.current) ? stats.pids_stats.current : null,
    rx: net.rx, tx: net.tx, rd: blk.rd, wr: blk.wr,
  };
}

/**
 * Per-second rates between two readings of one container. Each counter stands alone: one
 * that went backwards (the container restarted, the network was re-attached) gives null and
 * nothing else — never a negative rate, never a spike. No earlier reading, a window under a
 * second, or one longer than `maxWindowS`: all null. The long window matters: after a laptop
 * slept or a pass was skipped, the counters moved little over many hours, and dividing by the
 * whole gap would draw a confident near-zero instead of no figure.
 */
function ratesBetween(prev, cur, maxWindowS = Infinity) {
  const none = { cpuCores: null, rxBps: null, txBps: null, rdBps: null, wrBps: null };
  if (!prev || !cur) return none;
  const dt = (cur.t - prev.t) / 1000;
  if (!(dt >= MIN_WINDOW_S) || dt > maxWindowS) return none;
  const rate = (a, b) => (finite(a) && finite(b) && b >= a ? (b - a) / dt : null);
  const cpu = rate(prev.cpuNs, cur.cpuNs);
  return {
    cpuCores: cpu === null ? null : cpu / 1e9,
    rxBps: rate(prev.rx, cur.rx),
    txBps: rate(prev.tx, cur.tx),
    rdBps: rate(prev.rd, cur.rd),
    wrBps: rate(prev.wr, cur.wr),
  };
}

const round = (n, digits) => (n === null ? null : Number(n.toFixed(digits)));

/**
 * The container sampler: holds the previous counters of every container between calls (in
 * memory only — a daemon restart primes again) and the names it had to inspect.
 *
 * `request(method, path, timeoutMs)` is the Docker call (lib/docker-socket-path.js in the
 * daemon, a fake in a test); `now()` the clock; `maxWindowS` the longest gap between two
 * readings that still gives a rate (the daemon passes three sampling intervals).
 */
function createContainerSampler({ request, now = Date.now, maxWindowS = 180 }) {
  const previous = new Map(); // container id → counters
  const described = new Map(); // container id → display name
  let host = null;
  let hostAt = 0;

  async function readHost() {
    if (host && now() - hostAt < HOST_TTL_MS) return host;
    try {
      const info = await request('GET', '/info', REQUEST_TIMEOUT_MS);
      if (finite(info?.NCPU) && finite(info?.MemTotal) && info.NCPU > 0) {
        host = { ncpu: info.NCPU, memTotalMb: Math.round(info.MemTotal / MB) };
        hostAt = now();
      }
    } catch { /* keep the last answer; none yet → no host row */ }
    return host;
  }

  /** The name to show: an agent's AGENT_NAME (read once per container id), else the container's. */
  async function displayName(c, container) {
    if (!c.Labels?.AGENT_ID) return container;
    if (described.has(c.Id)) return described.get(c.Id);
    let name = container;
    try {
      const inspect = await request('GET', `/containers/${encodeURIComponent(c.Id)}/json`, REQUEST_TIMEOUT_MS);
      const entry = (inspect?.Config?.Env || []).find((e) => typeof e === 'string' && e.startsWith('AGENT_NAME='));
      name = cleanName(entry?.slice('AGENT_NAME='.length), container);
    } catch { /* fall back to the container name; asked again next time */ return name; }
    described.set(c.Id, name);
    return name;
  }

  /**
   * One pass over the running containers. Throws when the list itself cannot be read
   * (Docker down); a container whose stats fail is skipped, the others are kept.
   */
  async function sample() {
    const list = await request('GET', '/containers/json', REQUEST_TIMEOUT_MS);
    if (!Array.isArray(list)) throw new Error('unexpected answer from Docker');
    const atMs = now();
    const containers = [];
    for (const c of list) {
      const container = primaryName(c?.Names);
      if (!c?.Id || !CONTAINER_NAME_RE.test(container)) continue;
      containers.push({ c, container });
    }

    // The name (an inspect, agents only) runs beside the stats call, not after it: a slow
    // inspect must not stretch the pass by its timeout once per agent.
    const answers = await Promise.allSettled(containers.map(async ({ c, container }) => {
      const [stats, name] = await Promise.all([
        request('GET', `/containers/${encodeURIComponent(c.Id)}/stats?stream=false&one-shot=true`, REQUEST_TIMEOUT_MS),
        displayName(c, container),
      ]);
      return { c, container, name, counters: readCounters(stats, now()) };
    }));

    const rows = [];
    const sources = [];
    // Identity comes from the list itself — a container whose stats call failed was still
    // seen, so it keeps its place on the page (as stopped) instead of vanishing. Rates come
    // only from counters. Alive is what Docker lists, not what answered its stats call: one
    // timeout must not make a container forget its counters (the next pass would have no
    // rate) and its name.
    const live = new Set(containers.map(({ c }) => c.Id));
    for (let i = 0; i < containers.length; i++) {
      const { c, container } = containers[i];
      const a = answers[i];
      const name = a.status === 'fulfilled' ? a.value.name : container;
      const volumes = (c.Mounts || []).filter((m) => m?.Type === 'volume' && m.Name).map((m) => m.Name);
      sources.push({
        container,
        agent_id: c.Labels?.AGENT_ID ? String(c.Labels.AGENT_ID) : null,
        name,
        is_agent: c.Labels?.AGENT_ID ? 1 : 0,
        volumes: volumes.join(','),
      });
      if (a.status !== 'fulfilled') continue;
      const { counters } = a.value;
      if (!counters) continue; // just started: no CPU figure yet
      const rates = ratesBetween(previous.get(c.Id), counters, maxWindowS);
      previous.set(c.Id, counters);
      rows.push({
        container,
        cpu_cores: round(rates.cpuCores, 4),
        mem_mb: counters.memBytes === null ? null : Math.round(counters.memBytes / MB),
        pids: counters.pids,
        net_rx_bps: round(rates.rxBps, 0),
        net_tx_bps: round(rates.txBps, 0),
        blk_read_bps: round(rates.rdBps, 0),
        blk_write_bps: round(rates.wrBps, 0),
      });
    }
    // A container that is gone takes its counters with it (a new id starts from none).
    for (const id of previous.keys()) if (!live.has(id)) previous.delete(id);
    for (const id of described.keys()) if (!live.has(id)) described.delete(id);

    return { ts: Math.floor(atMs / 1000), host: await readHost(), rows, sources };
  }

  return { sample };
}

/**
 * `/system/df` as the readings worth keeping: each named volume (and what no container uses),
 * each container's writable layer, the images and the build cache in total with what
 * could be freed. Sizes in bytes; -1 (Docker could not size it) becomes null.
 * Returns null for anything that is not a df answer (an error body parses as JSON too) —
 * the caller keeps its last reading instead of writing zeros.
 */
function parseStorage(df) {
  if (!df || typeof df !== 'object' || !('Volumes' in df || 'Containers' in df || 'Images' in df || 'BuildCache' in df)) return null;
  const size = (n) => (finite(n) && n >= 0 ? n : null);
  const volumes = (df?.Volumes || [])
    .filter((v) => v?.Name)
    .map((v) => ({
      name: String(v.Name),
      sizeBytes: size(v.UsageData?.Size),
      unused: (v.UsageData?.RefCount ?? 0) === 0,
    }));
  const layers = (df?.Containers || [])
    .map((c) => ({ container: primaryName(c?.Names), sizeBytes: size(c?.SizeRw) }))
    .filter((l) => CONTAINER_NAME_RE.test(l.container));
  const images = df?.Images || [];
  const cache = df?.BuildCache || [];
  const sum = (items, pick) => items.reduce((acc, x) => acc + (size(pick(x)) ?? 0), 0);
  return {
    volumes,
    layers,
    images: {
      // LayersSize counts shared layers once, unlike summing each image.
      sizeBytes: size(df?.LayersSize) ?? sum(images, (i) => i.Size),
      reclaimableBytes: sum(images.filter((i) => (i.Containers ?? 0) === 0), (i) => i.Size),
    },
    buildCache: {
      sizeBytes: sum(cache, (e) => e.Size),
      // Docker's own "reclaimable" figure for the cache reads a few KB next to a cache of
      // 1.7 GB (observed): what `docker builder prune` can free is what no build uses.
      reclaimableBytes: sum(cache.filter((e) => e.InUse === false), (e) => e.Size),
    },
  };
}

module.exports = {
  CONTAINER_NAME_RE, DF_TIMEOUT_MS, MB,
  cleanName, primaryName, workingSetBytes, sumNetwork, sumBlockIo, readCounters, ratesBetween,
  createContainerSampler, parseStorage,
};
