#!/usr/bin/env node
/**
 * Rev4a Daemon — SQLite event logger
 * Reads every running agent's OpenClaw sessions from its own container (agent_sessions in
 * events.db, with transition events), samples the host machine
 * (CPU, RAM, swap, storage) every 30s, samples what each container consumes every 60s
 * (metrics.db), and every 5 min reads what each running agent spent, as its OpenClaw priced
 * it, into costs.db — each on a timer of its own.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const { spawnSync, execFile } = require('child_process');
const Database = require('better-sqlite3');
const path = require('path');
// Shared with the dashboard (lib/docker-socket.ts): one copy of where the Docker socket is.
const http = require('http');
const { dockerRequestJson, resolveDockerSocket } = require('./lib/docker-socket-path.js');
const dockerStats = require('./lib/docker-stats.js');
const execTimeout = require('./lib/exec-timeout.js');
const { EVENTS_RETENTION_MS, pruneEvents } = require('./lib/events-retention.js');
const { createContainerAnomalyDetector } = require('./lib/container-anomalies.js');
const { parseStatus: parsePackagesStatus, statusAlertKey: packagesAlertKey, failureMessage: packagesFailureMessage, splitFailed: splitPackagesFailed } = require('./lib/agent-packages.js');
const { oomEventsToAnomalies, createLineSplitter, createOomTracker, bytesToMb } = require('./lib/agent-memory-limit.js');
const agentSessions = require('./lib/agent-sessions.js');
const { CREATE_TABLE_SQL: PROXY_USAGE_TABLE_SQL, PROXY_USAGE_RETENTION_MS } = require('./lib/proxy-usage.js');

// Same rule as lib/rev4a-paths.ts: REV4A_DB, else <data dir>/data/events.db, where the data
// dir is REV4A_DATA_DIR or ~/.config/rev4a — the API reads the files the daemon writes.
const DATA_DIR = process.env.REV4A_DATA_DIR
  || (process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'rev4a')
    : path.join(os.homedir(), '.config', 'rev4a'));
const DB_PATH = process.env.REV4A_DB || path.join(DATA_DIR, 'data', 'events.db');

// No cost is estimated here. What agents spend is priced by each agent's own OpenClaw
// and read by the Agent Costs timer below into costs.db.

// ── DB Setup ────────────────────────────────────────────────────────────────

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  log('✅ Database connected, WAL mode active');
} catch (err) {
  console.error(`[FATAL] Cannot open DB at ${DB_PATH}: ${err.message}`);
  console.error(`Verify: path exists, permissions on ${path.dirname(DB_PATH)}/, disk space`);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error(`[UNCAUGHT] ${err.message}\n${err.stack}`);
  console.error('Daemon will attempt restart via watchdog cron');
  // Do NOT exit — the watchdog reads this from the healthcheck
});

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  parent_id TEXT,
  label TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  status TEXT DEFAULT 'idle',
  task_preview TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  updated_at INTEGER,
  trello_card_url TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
`);

// Add trello_card_url column if it doesn't exist (migration)
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN trello_card_url TEXT`);
} catch (e) {
  // Column already exists — ignore
}

// Fix 1 — Add ended_at column (migration safe)
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN ended_at INTEGER`);
} catch (e) {
  // Column already exists — ignore
}

const insertEvent = db.prepare(`
  INSERT INTO events (ts, session_id, type, data) VALUES (@ts, @session_id, @type, @data)
`);


// ── System Metrics ───────────────────────────────────────────────────────────
//
// Machine-wide CPU, RAM, swap and storage of the host Rev4a runs on, sampled on their
// own timer (METRICS_INTERVAL_MS) — independent of the agent sessions collector below, which has
// no source on a host without the `openclaw` CLI.

/**
 * Machine metrics live in their own database next to events.db, so the event log stays
 * sessions and events only and the history can be dropped without touching them. The
 * daemon is its only writer; GET /api/metrics reads it (lib/metrics-db.ts, same path).
 * Anomalies are still events, in events.db, where the live feed reads them.
 *
 * Opened in a try: a metrics.db that cannot be opened (corrupt, unwritable, disk full)
 * turns sampling off with a log line and leaves the session poll running.
 */
const METRICS_DB_PATH = path.join(path.dirname(DB_PATH), 'metrics.db');
const metrics = openMetricsStore();

function openMetricsStore() {
  try {
    const mdb = new Database(METRICS_DB_PATH);
    mdb.pragma('journal_mode = WAL');
    mdb.pragma('synchronous = NORMAL');
    mdb.exec(`
CREATE TABLE IF NOT EXISTS system_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  cpu_percent REAL,
  ram_used_mb INTEGER,
  ram_total_mb INTEGER,
  swap_used_mb INTEGER,
  swap_total_mb INTEGER,
  load_avg_1m REAL,
  load_avg_5m REAL,
  load_avg_15m REAL
);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON system_metrics(ts);

CREATE TABLE IF NOT EXISTS system_disks (
  ts INTEGER NOT NULL,
  mount TEXT NOT NULL,
  roles TEXT,
  used_mb INTEGER,
  avail_mb INTEGER,
  total_mb INTEGER
);
CREATE INDEX IF NOT EXISTS idx_disks_ts ON system_disks(ts);
CREATE INDEX IF NOT EXISTS idx_disks_mount_ts ON system_disks(mount, ts);

-- What each running container consumes, one row per container per sample (60 s). CPU is in
-- cores (CPU-seconds per second) and every rate in bytes per second, both null for the first
-- sample after a start and after a counter reset. Memory is the working set. A stopped
-- container has no rows: a gap, not zeros.
CREATE TABLE IF NOT EXISTS container_metrics (
  ts INTEGER NOT NULL,
  container TEXT NOT NULL,
  cpu_cores REAL,
  mem_mb INTEGER,
  pids INTEGER,
  net_rx_bps INTEGER,
  net_tx_bps INTEGER,
  blk_read_bps INTEGER,
  blk_write_bps INTEGER
);
CREATE INDEX IF NOT EXISTS idx_container_metrics_ts ON container_metrics(ts);
CREATE INDEX IF NOT EXISTS idx_container_metrics_c_ts ON container_metrics(container, ts);

-- Who each container is: the agent's name (AGENT_NAME), whether it is an agent, and its named
-- volumes (the link to docker_storage).
CREATE TABLE IF NOT EXISTS container_sources (
  container TEXT PRIMARY KEY,
  agent_id TEXT,
  name TEXT,
  is_agent INTEGER NOT NULL DEFAULT 0,
  volumes TEXT,
  last_seen INTEGER NOT NULL
);

-- Docker's own cores and memory: the denominators for a container's share (on Docker Desktop
-- that is its VM, not the Mac).
CREATE TABLE IF NOT EXISTS docker_host (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ncpu INTEGER,
  mem_total_mb INTEGER,
  updated_at INTEGER
);

-- Disk Docker holds, read from /system/df every 10 min: kind 'volume' (name = the volume;
-- reclaimable_mb = its size when no container uses it), 'layer' (a container's writable layer),
-- 'images' and 'build_cache' (totals, with what could be freed).
CREATE TABLE IF NOT EXISTS docker_storage (
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  size_mb INTEGER,
  reclaimable_mb INTEGER
);
CREATE INDEX IF NOT EXISTS idx_docker_storage_ts ON docker_storage(ts);
CREATE INDEX IF NOT EXISTS idx_docker_storage_kind_ts ON docker_storage(kind, name, ts);
`);
    return {
      db: mdb,
      insertMetric: mdb.prepare(`
        INSERT INTO system_metrics (ts, cpu_percent, ram_used_mb, ram_total_mb, swap_used_mb, swap_total_mb,
          load_avg_1m, load_avg_5m, load_avg_15m)
        VALUES (@ts, @cpu_percent, @ram_used_mb, @ram_total_mb, @swap_used_mb, @swap_total_mb,
          @load_avg_1m, @load_avg_5m, @load_avg_15m)
      `),
      insertDisk: mdb.prepare(`
        INSERT INTO system_disks (ts, mount, roles, used_mb, avail_mb, total_mb)
        VALUES (@ts, @mount, @roles, @used_mb, @avail_mb, @total_mb)
      `),
      pruneMetrics: mdb.prepare('DELETE FROM system_metrics WHERE ts < ?'),
      pruneDisks: mdb.prepare('DELETE FROM system_disks WHERE ts < ?'),
      getLastTwoMetrics: mdb.prepare('SELECT cpu_percent, ram_used_mb, ram_total_mb FROM system_metrics ORDER BY ts DESC LIMIT 2'),
      insertContainerMetric: mdb.prepare(`
        INSERT INTO container_metrics (ts, container, cpu_cores, mem_mb, pids, net_rx_bps, net_tx_bps, blk_read_bps, blk_write_bps)
        VALUES (@ts, @container, @cpu_cores, @mem_mb, @pids, @net_rx_bps, @net_tx_bps, @blk_read_bps, @blk_write_bps)
      `),
      upsertContainerSource: mdb.prepare(`
        INSERT INTO container_sources (container, agent_id, name, is_agent, volumes, last_seen)
        VALUES (@container, @agent_id, @name, @is_agent, @volumes, @last_seen)
        ON CONFLICT(container) DO UPDATE SET agent_id = excluded.agent_id, name = excluded.name,
          is_agent = excluded.is_agent, volumes = excluded.volumes, last_seen = excluded.last_seen
      `),
      upsertDockerHost: mdb.prepare(`
        INSERT INTO docker_host (id, ncpu, mem_total_mb, updated_at) VALUES (1, @ncpu, @mem_total_mb, @updated_at)
        ON CONFLICT(id) DO UPDATE SET ncpu = excluded.ncpu, mem_total_mb = excluded.mem_total_mb, updated_at = excluded.updated_at
      `),
      insertDockerStorage: mdb.prepare(`
        INSERT INTO docker_storage (ts, kind, name, size_mb, reclaimable_mb) VALUES (@ts, @kind, @name, @size_mb, @reclaimable_mb)
      `),
      pruneContainerMetrics: mdb.prepare('DELETE FROM container_metrics WHERE ts < ?'),
      pruneContainerSources: mdb.prepare('DELETE FROM container_sources WHERE last_seen < ?'),
      pruneDockerStorage: mdb.prepare('DELETE FROM docker_storage WHERE ts < ?'),
    };
  } catch (err) {
    log(`[METRICS] disabled: cannot open ${METRICS_DB_PATH}: ${err.message}`);
    return null;
  }
}

const METRICS_INTERVAL_MS = 30_000;
const METRICS_RETENTION_S = 30 * 24 * 3600;
/** How long to wait before asking Docker for its root directory again after a failure. */
const DOCKER_ROOT_RETRY_MS = 10 * 60 * 1000;

// Anomaly cooldown: last alert per metric (cpu, ram); disks use the crossing state below
const lastAnomalyAlert = {};
const ANOMALY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const DISK_ANOMALY_PERCENT = 90; // at or above, like the System page's critical level
/** Filesystems above the threshold: a disk stays full, so it is reported once per crossing (and once after a restart — in memory only). */
const diskAboveThreshold = new Set();

/** Host CPU ticks summed over every core (`/proc/stat` on Linux): the whole machine. */
function readHostCpuSample() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

let lastCpuSample = readHostCpuSample();

/** Busy share of all cores since the previous sample, 0-100. */
function getCpuPercent() {
  const sample = readHostCpuSample();
  const deltaTotal = sample.total - lastCpuSample.total;
  const deltaIdle = sample.idle - lastCpuSample.idle;
  lastCpuSample = sample;
  if (deltaTotal <= 0) return 0;
  const busy = Math.max(0, deltaTotal - deltaIdle);
  return Number(Math.max(0, Math.min(100, (busy / deltaTotal) * 100)).toFixed(2));
}

/**
 * macOS (development): used = active + wired + compressed pages, close to Activity
 * Monitor's "Memory Used" — os.freemem() there counts only free pages, so the cache
 * would read as used and every Mac would sit near 100 %. Swap from `vm.swapusage`.
 */
function getDarwinMemory() {
  const vm = spawnSync('vm_stat', { encoding: 'utf8', timeout: 3000 });
  if (vm.status !== 0) return null;
  const pageSize = Number(/page size of (\d+) bytes/.exec(vm.stdout)?.[1]);
  const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vm.stdout)?.[1] ?? NaN);
  const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize;
  if (!Number.isFinite(used)) return null;
  const swap = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 3000 });
  const swapMb = (label) => Number(new RegExp(`${label} = ([\\d.]+)M`).exec(swap.stdout || '')?.[1] ?? NaN);
  const swapTotal = swapMb('total');
  return {
    ram_used_mb: Math.round(used / 1024 / 1024),
    ram_total_mb: Math.round(os.totalmem() / 1024 / 1024),
    swap_used_mb: Number.isFinite(swapTotal) ? Math.round(swapMb('used')) : null,
    swap_total_mb: Number.isFinite(swapTotal) ? Math.round(swapTotal) : null,
  };
}

/**
 * RAM and swap in MB. On Linux from /proc/meminfo: used = MemTotal − MemAvailable, the
 * figure `free` reports (page cache the kernel can reclaim is not "used"). On macOS see
 * getDarwinMemory(); anywhere else os.totalmem()/os.freemem(), and no swap.
 */
function getMemory() {
  const mb = (kb) => Math.round(kb / 1024);
  if (process.platform === 'darwin') {
    const mac = getDarwinMemory();
    if (mac) return mac;
  }
  try {
    const info = {};
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      if (m) info[m[1]] = Number(m[2]);
    }
    if (info.MemTotal && info.MemAvailable !== undefined) {
      return {
        ram_used_mb: mb(info.MemTotal - info.MemAvailable),
        ram_total_mb: mb(info.MemTotal),
        swap_used_mb: mb((info.SwapTotal || 0) - (info.SwapFree || 0)),
        swap_total_mb: mb(info.SwapTotal || 0),
      };
    }
  } catch { /* not Linux */ }
  const total = os.totalmem();
  return {
    ram_used_mb: Math.round((total - os.freemem()) / 1024 / 1024),
    ram_total_mb: Math.round(total / 1024 / 1024),
    swap_used_mb: null,
    swap_total_mb: null,
  };
}

let dockerRootDir = null;
let dockerRootCheckedAt = 0;

/** Docker's data root (where images and agent volumes live), asked once and cached. */
function getDockerRootDir() {
  if (dockerRootDir || Date.now() - dockerRootCheckedAt < DOCKER_ROOT_RETRY_MS) return dockerRootDir;
  dockerRootCheckedAt = Date.now();
  const r = spawnSync('docker', ['info', '--format', '{{.DockerRootDir}}'], { encoding: 'utf8', timeout: 5000 });
  const dir = r.status === 0 ? String(r.stdout).trim() : '';
  if (dir.startsWith('/')) dockerRootDir = dir;
  return dockerRootDir;
}

/**
 * The filesystems worth watching: `/`, Docker's root and Rev4a's data directory, each
 * filesystem once (paths on the same device are merged, their roles listed together).
 * A path that cannot be read — Docker Desktop's root lives inside its VM — is skipped.
 * Sizes follow `df`: used = blocks − free, avail = what a normal user can still write.
 */
function getDisks() {
  const candidates = [
    ['/', 'root'],
    [getDockerRootDir(), 'docker'],
    [path.dirname(DB_PATH), 'data'],
  ];
  const byDevice = new Map();
  for (const [mount, role] of candidates) {
    if (!mount) continue;
    try {
      const dev = fs.statSync(mount).dev;
      const known = byDevice.get(dev);
      if (known) { known.roles.push(role); continue; }
      const st = fs.statfsSync(mount);
      const mb = (blocks) => Math.round((blocks * st.bsize) / 1024 / 1024);
      byDevice.set(dev, {
        mount,
        roles: [role],
        used_mb: mb(st.blocks - st.bfree),
        avail_mb: mb(st.bavail),
        total_mb: mb(st.blocks),
      });
    } catch { /* not readable here */ }
  }
  return [...byDevice.values()];
}

/** Share of a filesystem in use the way `df` computes it: used / (used + avail). */
function diskPercent(d) {
  const denom = d.used_mb + d.avail_mb;
  return denom > 0 ? Math.round((d.used_mb / denom) * 100) : 0;
}

/**
 * Write a system_anomaly event. `cooldownKey` limits it to one per ANOMALY_COOLDOWN_MS; null writes it now.
 * `extra` adds fields to the event data (additive: readers ignore what they do not know).
 */
function recordAnomaly(cooldownKey, metric, values, threshold, message, extra) {
  const nowMs = Date.now();
  if (cooldownKey) {
    if (nowMs - (lastAnomalyAlert[cooldownKey] || 0) <= ANOMALY_COOLDOWN_MS) return;
    lastAnomalyAlert[cooldownKey] = nowMs;
  }
  insertEvent.run({
    ts: nowMs,
    session_id: 'system',
    type: 'system_anomaly',
    data: JSON.stringify({ metric, values, threshold, message, ...(extra || {}) }),
  });
  log(`[ANOMALY] ${message}`);
}

function collectSystemMetrics() {
  const now = Math.floor(Date.now() / 1000);
  const cpu_percent = getCpuPercent();
  const mem = getMemory();
  const disks = getDisks();
  const [load1, load5, load15] = os.loadavg().map((v) => Number(v.toFixed(2)));

  metrics.db.transaction(() => {
    metrics.insertMetric.run({
      ts: now,
      cpu_percent,
      ...mem,
      load_avg_1m: load1,
      load_avg_5m: load5,
      load_avg_15m: load15,
    });
    for (const d of disks) metrics.insertDisk.run({ ts: now, ...d, roles: d.roles.join(',') });
    metrics.pruneMetrics.run(now - METRICS_RETENTION_S);
    metrics.pruneDisks.run(now - METRICS_RETENTION_S);
  })();

  // Anomalies: CPU > 85 % and RAM > 90 % on two consecutive samples (with a cooldown); a
  // filesystem once when it reaches DISK_ANOMALY_PERCENT, again only after it drops back
  // under it — disk usage does not spike and fall back, a cooldown would repeat forever.
  const recent = metrics.getLastTwoMetrics.all();
  if (recent.length === 2) {
    if (recent[0].cpu_percent > 85 && recent[1].cpu_percent > 85) {
      recordAnomaly('cpu', 'cpu', [recent[1].cpu_percent, recent[0].cpu_percent], 85,
        `CPU high: ${recent[0].cpu_percent}% for 2 consecutive samples`);
    }
    const pct = (r) => (r.ram_total_mb > 0 ? Math.round((r.ram_used_mb / r.ram_total_mb) * 100) : 0);
    if (pct(recent[0]) > 90 && pct(recent[1]) > 90) {
      recordAnomaly('ram', 'ram', [pct(recent[1]), pct(recent[0])], 90,
        `RAM high: ${pct(recent[0])}% for 2 consecutive samples`);
    }
  }
  for (const d of disks) {
    const p = diskPercent(d);
    if (p < DISK_ANOMALY_PERCENT) {
      diskAboveThreshold.delete(d.mount);
    } else if (!diskAboveThreshold.has(d.mount)) {
      diskAboveThreshold.add(d.mount);
      recordAnomaly(null, 'disk', [p], DISK_ANOMALY_PERCENT, `Disk high: ${d.mount} ${p}% used`);
    }
  }
}

// ── Container consumption ────────────────────────────────────────────────────
//
// What each running container uses — CPU, memory, processes, network, block I/O — and the
// disk Docker holds for them, so the System page can say *who* is using the machine. Read from
// the Docker Engine API (lib/docker-stats.js); written to metrics.db, next to the machine's
// own numbers. Every running container, agents and the rest alike: the page tells them apart.

const CONTAINERS_INTERVAL_MS = 60_000;
/** The first pass only primes the CPU counters; the second, this long after, is the first with a CPU figure. */
const CONTAINERS_FIRST_DELAY_MS = 6_000;
const CONTAINERS_SECOND_DELAY_MS = 15_000;
const STORAGE_INTERVAL_MS = 10 * 60_000;
const STORAGE_FIRST_DELAY_MS = 25_000;

// A rate over a gap longer than three intervals (a laptop that slept, skipped passes) is no rate.
const containerSampler = dockerStats.createContainerSampler({
  request: dockerRequestJson,
  maxWindowS: (3 * CONTAINERS_INTERVAL_MS) / 1000,
});
// Keeps its own streaks and its 60-minute cooldown (started by markRecorded after a successful write), so its events are written with a null key.
const containerAnomalies = createContainerAnomalyDetector();
const failedAnomalyKeys = new Set(); // keys whose last write failed: logged once, not every pass
let containersRunning = false;
let dockerContainersDown = false;

async function collectContainerMetrics() {
  if (!metrics || containersRunning) return;
  containersRunning = true;
  try {
    let sample;
    try {
      sample = await containerSampler.sample();
      dockerContainersDown = false;
    } catch (e) {
      // Docker down or not yet up: said once, not every minute; it recovers by itself.
      if (!dockerContainersDown) log(`[CONTAINERS] Docker unreachable: ${e.message}`);
      dockerContainersDown = true;
      return;
    }
    metrics.db.transaction(() => {
      for (const row of sample.rows) metrics.insertContainerMetric.run({ ts: sample.ts, ...row });
      for (const source of sample.sources) metrics.upsertContainerSource.run({ ...source, last_seen: sample.ts });
      if (sample.host) metrics.upsertDockerHost.run({ ncpu: sample.host.ncpu, mem_total_mb: sample.host.memTotalMb, updated_at: sample.ts });
      metrics.pruneContainerMetrics.run(sample.ts - METRICS_RETENTION_S);
      metrics.pruneContainerSources.run(sample.ts - METRICS_RETENTION_S);
    })();
    // Only a sample that was read and stored gets here; a failed one returned above.
    try {
      const nowMs = Date.now();
      // A container that left the sample cannot be retried: forget its failed writes (no growth).
      const present = new Set([...sample.rows, ...(sample.sources || [])].map((r) => r && r.container));
      for (const key of failedAnomalyKeys) if (!present.has(key.slice(key.indexOf(':') + 1))) failedAnomalyKeys.delete(key);
      for (const a of containerAnomalies.observe(sample, nowMs)) {
        // One write per try: a failing one must not skip the others, and its cooldown
        // starts only once the event is stored, so it is tried again on the next pass.
        try {
          recordAnomaly(null, a.metric, a.values, a.threshold, a.message);
          containerAnomalies.markRecorded(a.key, nowMs);
          failedAnomalyKeys.delete(a.key);
        } catch (e) {
          if (!failedAnomalyKeys.has(a.key)) log(`[CONTAINERS] could not record ${a.key}: ${e.message}`);
          failedAnomalyKeys.add(a.key);
        }
      }
    } catch (e) {
      log(`[CONTAINERS] anomaly check failed: ${e.message}`);
    }
  } finally {
    containersRunning = false;
  }
}

// ── Out-of-memory kills ──────────────────────────────────────────────────────
// A container with a memory limit that goes over it has a process killed by the kernel,
// and with `--restart unless-stopped` it is back within seconds: `State.OOMKilled` is
// true for about a second and is reset when it starts again. The one durable trace is
// Docker's `oom` event (one per kill, also when only a child such as Chrome dies and
// the container survives; a container without a limit can be killed by the host too).
// Read from a long-lived GET /events stream: Docker replays only its last 256 events of
// every type, and Rev4a's own `docker exec` polling fills that buffer, so a replay poll
// could lose the event. A live stream applies the filters server-side and has no buffer.

const OOM_RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const OOM_RETRY_MS = 60_000;
const oomTracker = createOomTracker();
let oomStreamReq = null;
let oomStreamStopped = false;
let oomReconnectTimer = null;
let oomRetryTimer = null;
let oomAttempt = 0;
let oomLastSeenS = null;
let oomOutage = false;
let oomStableTimer = null;
/** A stream counts as back only after it stayed open this long (or delivered an event), so one that opens and closes at once keeps backing off. */
const OOM_STABLE_MS = 30_000;

function markOomStreamStable() {
  clearTimeout(oomStableTimer);
  oomStableTimer = null;
  if (oomOutage) log("[CONTAINERS] Docker's out-of-memory event stream is back");
  oomOutage = false;
  oomLastSeenS = null;
  oomAttempt = 0;
}

/** The container's limit in MB read at event time, best effort: null when it has none or cannot be read. */
async function containerLimitMb(id) {
  try {
    const info = await dockerRequestJson('GET', `/containers/${encodeURIComponent(id)}/json`, 5_000);
    return bytesToMb(info && info.HostConfig && info.HostConfig.Memory);
  } catch {
    return null;
  }
}

/** Writes the alerts that are due. A failed write stays pending and is tried again (next event or within a minute). */
function flushOomAlerts() {
  const nowMs = Date.now();
  for (const d of oomTracker.due(nowMs)) {
    try {
      recordAnomaly(null, 'container_oom', d.anomaly.values, null, d.message, { container: d.container, kills: d.kills });
      oomTracker.markRecorded(d.container, nowMs);
    } catch (e) {
      log(`[CONTAINERS] could not record an out-of-memory event for ${d.container}: ${e.message}`);
    }
  }
}

async function handleOomEvent(ev) {
  try {
    const t = ev && (typeof ev.timeNano === 'number' ? ev.timeNano / 1e9 : ev.time);
    if (typeof t === 'number' && Number.isFinite(t)) oomLastSeenS = Math.floor(t);
    const attrs = ev && ev.Actor && ev.Actor.Attributes;
    const name = attrs && attrs.name;
    const limit = typeof name === 'string' && ev.Actor.ID ? await containerLimitMb(ev.Actor.ID) : null;
    const anomalies = oomEventsToAnomalies([ev], typeof name === 'string' ? { [name]: limit } : {});
    for (const a of anomalies) oomTracker.kill(a, Date.now());
    flushOomAlerts();
  } catch (e) {
    log(`[CONTAINERS] could not handle an out-of-memory event: ${e.message}`);
  }
}

function scheduleOomReconnect() {
  if (oomStreamStopped || oomReconnectTimer) return;
  const delay = OOM_RECONNECT_BACKOFF_MS[Math.min(oomAttempt, OOM_RECONNECT_BACKOFF_MS.length - 1)];
  oomAttempt += 1;
  oomReconnectTimer = setTimeout(() => { oomReconnectTimer = null; openOomStream(); }, delay);
  oomReconnectTimer.unref?.();
}

function oomStreamLost(reason, sinceS) {
  oomStreamReq = null;
  clearTimeout(oomStableTimer);
  oomStableTimer = null;
  if (oomStreamStopped) return;
  if (!oomOutage) {
    oomOutage = true;
    oomLastSeenS = oomLastSeenS ?? sinceS;
    log(`[CONTAINERS] Docker's out-of-memory event stream is down: ${reason}; reconnecting`);
  }
  scheduleOomReconnect();
}

/** Opens the live stream; never throws. `since` is set only on a reconnect (best-effort replay of the gap). */
function openOomStream() {
  if (oomStreamStopped || oomStreamReq) return;
  try {
    const socketPath = resolveDockerSocket();
    if (!socketPath) { oomStreamLost('Docker socket not found', Math.floor(Date.now() / 1000)); return; }
    const disconnectS = Math.floor(Date.now() / 1000);
    const filters = encodeURIComponent(JSON.stringify({ type: ['container'], event: ['oom'], label: ['AGENT_ID'] }));
    const since = oomOutage ? `since=${oomLastSeenS ?? disconnectS}&` : '';
    const splitter = createLineSplitter();
    const req = http.request(
      { socketPath, method: 'GET', path: `/events?${since}filters=${filters}`, headers: { Host: 'localhost' } },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          oomStreamLost(`Docker error ${res.statusCode}`, disconnectS);
          return;
        }
        // Not "back" yet: only once it stays open or delivers an event (see markOomStreamStable).
        clearTimeout(oomStableTimer);
        oomStableTimer = setTimeout(markOomStreamStable, OOM_STABLE_MS);
        oomStableTimer.unref?.();
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (oomStableTimer) markOomStreamStable();
          try { for (const ev of splitter.push(chunk)) void handleOomEvent(ev); } catch (e) { log(`[CONTAINERS] out-of-memory stream parse error: ${e.message}`); }
        });
        res.on('end', () => oomStreamLost('the stream ended', Math.floor(Date.now() / 1000)));
        res.on('error', (e) => oomStreamLost(e.message, Math.floor(Date.now() / 1000)));
      },
    );
    oomStreamReq = req;
    req.on('error', (e) => oomStreamLost(e.message, disconnectS));
    req.end();
  } catch (e) {
    oomStreamLost(e.message, Math.floor(Date.now() / 1000));
  }
}

function startOomStream() {
  openOomStream();
  oomRetryTimer = setInterval(flushOomAlerts, OOM_RETRY_MS);
  oomRetryTimer.unref?.();
}

function stopOomStream() {
  oomStreamStopped = true;
  clearTimeout(oomReconnectTimer);
  clearTimeout(oomStableTimer);
  clearInterval(oomRetryTimer);
  try { oomStreamReq?.destroy(); } catch { /* closing anyway */ }
  oomStreamReq = null;
}

let storageRunning = false;
let dockerStorageFailing = false;

async function collectDockerStorage() {
  if (!metrics || storageRunning) return;
  storageRunning = true;
  try {
    let df;
    try {
      df = dockerStats.parseStorage(await dockerRequestJson('GET', '/system/df', dockerStats.DF_TIMEOUT_MS));
      if (!df) throw new Error('not a /system/df answer');
      dockerStorageFailing = false;
    } catch (e) {
      // The last reading stays in the table: a failed one records nothing.
      if (!dockerStorageFailing) log(`[CONTAINERS] Docker storage unreadable: ${e.message}`);
      dockerStorageFailing = true;
      return;
    }
    const ts = Math.floor(Date.now() / 1000);
    const mb = (bytes) => (bytes === null ? null : Math.round(bytes / dockerStats.MB));
    metrics.db.transaction(() => {
      for (const v of df.volumes) {
        metrics.insertDockerStorage.run({ ts, kind: 'volume', name: v.name, size_mb: mb(v.sizeBytes), reclaimable_mb: v.unused ? mb(v.sizeBytes) : 0 });
      }
      for (const l of df.layers) {
        metrics.insertDockerStorage.run({ ts, kind: 'layer', name: l.container, size_mb: mb(l.sizeBytes), reclaimable_mb: null });
      }
      metrics.insertDockerStorage.run({ ts, kind: 'images', name: '', size_mb: mb(df.images.sizeBytes), reclaimable_mb: mb(df.images.reclaimableBytes) });
      metrics.insertDockerStorage.run({ ts, kind: 'build_cache', name: '', size_mb: mb(df.buildCache.sizeBytes), reclaimable_mb: mb(df.buildCache.reclaimableBytes) });
      metrics.pruneDockerStorage.run(ts - METRICS_RETENTION_S);
    })();
  } finally {
    storageRunning = false;
  }
}

// ── Agent Costs ──────────────────────────────────────────────────────────────
//
// What each agent spent, as its own OpenClaw computed it. Rev4a writes every model's
// price into the synced `rev4a` provider block (app/api/gateway/sync.ts); OpenClaw then
// prices each call, session and day itself. This timer reads those figures from each
// running agent's Gateway and keeps them, so a stopped or deleted agent keeps its
// history. Nothing here computes a cost.

/**
 * Its own database next to events.db, like metrics.db: the daemon is the only writer;
 * the API reads it through lib/costs-db.ts (same path) — the Costs page, the dashboard,
 * system-health and the agent panel. Days are UTC dates, as
 * OpenClaw buckets them by default and as DeepSeek schedules its rates.
 *
 * Opened in a try: a costs.db that cannot be opened turns collection off with a log line.
 */
const COSTS_DB_PATH = path.join(path.dirname(DB_PATH), 'costs.db');
const costs = openCostsStore();

function openCostsStore() {
  try {
    const cdb = new Database(COSTS_DB_PATH);
    cdb.pragma('journal_mode = WAL');
    cdb.pragma('synchronous = NORMAL');
    cdb.exec(`
CREATE TABLE IF NOT EXISTS agent_cost_daily (
  container TEXT NOT NULL,
  date TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  input_cost REAL NOT NULL DEFAULT 0,
  output_cost REAL NOT NULL DEFAULT 0,
  cache_read_cost REAL NOT NULL DEFAULT 0,
  cache_write_cost REAL NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (container, date)
);
CREATE TABLE IF NOT EXISTS agent_cost_model_daily (
  container TEXT NOT NULL,
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (container, date, provider, model)
);
CREATE TABLE IF NOT EXISTS agent_cost_sessions (
  container TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_key TEXT,
  label TEXT,
  agent_id TEXT,
  provider TEXT,
  model TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  first_activity INTEGER,
  last_activity INTEGER,
  PRIMARY KEY (container, session_id)
);
CREATE INDEX IF NOT EXISTS idx_cost_sessions_last ON agent_cost_sessions(last_activity);
-- The vendor's own figure next to what the agents priced, taken together (see
-- collectVendorBalances): the difference between two rows compares the same interval.
CREATE TABLE IF NOT EXISTS vendor_balance (
  ts INTEGER NOT NULL,
  vendor TEXT NOT NULL,
  currency TEXT,
  balance REAL,
  usage REAL,
  agents_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (vendor, ts)
);
CREATE TABLE IF NOT EXISTS agent_cost_sources (
  container TEXT PRIMARY KEY,
  agent_id TEXT,
  name TEXT,
  collected_at INTEGER,
  attempted_at INTEGER,
  error TEXT,
  missing_by_model TEXT
);
`);
    // What the Rev4a provider proxy metered, per hour, agent and model. The proxy (the Next.js
    // process) is the writer, and creates the table itself too if it gets there first; the daemon
    // only guarantees it exists and prunes it. See lib/proxy-usage.js.
    cdb.exec(PROXY_USAGE_TABLE_SQL);
    return {
      db: cdb,
      clearDaily: cdb.prepare('DELETE FROM agent_cost_daily WHERE container = ? AND date >= ?'),
      clearModelDaily: cdb.prepare('DELETE FROM agent_cost_model_daily WHERE container = ? AND date >= ?'),
      insertDaily: cdb.prepare(`
        INSERT INTO agent_cost_daily (container, date, input, output, cache_read, cache_write, total_tokens,
          cost, input_cost, output_cost, cache_read_cost, cache_write_cost, missing)
        VALUES (@container, @date, @input, @output, @cache_read, @cache_write, @total_tokens,
          @cost, @input_cost, @output_cost, @cache_read_cost, @cache_write_cost, @missing)
      `),
      insertModelDaily: cdb.prepare(`
        INSERT OR REPLACE INTO agent_cost_model_daily (container, date, provider, model, tokens, cost, calls)
        VALUES (@container, @date, @provider, @model, @tokens, @cost, @calls)
      `),
      upsertSession: cdb.prepare(`
        INSERT INTO agent_cost_sessions (container, session_id, session_key, label, agent_id, provider, model,
          tokens, cost, missing, first_activity, last_activity)
        VALUES (@container, @session_id, @session_key, @label, @agent_id, @provider, @model,
          @tokens, @cost, @missing, @first_activity, @last_activity)
        ON CONFLICT(container, session_id) DO UPDATE SET
          session_key = excluded.session_key, label = excluded.label, agent_id = excluded.agent_id,
          provider = excluded.provider, model = excluded.model, tokens = excluded.tokens, cost = excluded.cost,
          missing = excluded.missing, first_activity = excluded.first_activity, last_activity = excluded.last_activity
      `),
      insertBalance: cdb.prepare(`
        INSERT OR REPLACE INTO vendor_balance (ts, vendor, currency, balance, usage, agents_cost)
        VALUES (@ts, @vendor, @currency, @balance, @usage, @agents_cost)
      `),
      lastBalanceTs: cdb.prepare('SELECT MAX(ts) AS ts FROM vendor_balance WHERE vendor = ?'),
      pruneBalances: cdb.prepare('DELETE FROM vendor_balance WHERE ts < ?'),
      pruneProxyUsage: cdb.prepare('DELETE FROM proxy_usage_hourly WHERE hour < ?'),
      agentsCostFor: cdb.prepare(`SELECT COALESCE(SUM(cost), 0) AS cost FROM agent_cost_model_daily WHERE model LIKE ? || '/%'`),
      upsertSource: cdb.prepare(`
        INSERT INTO agent_cost_sources (container, agent_id, name, collected_at, attempted_at, error, missing_by_model)
        VALUES (@container, @agent_id, @name, @collected_at, @attempted_at, @error, @missing_by_model)
        ON CONFLICT(container) DO UPDATE SET
          agent_id = excluded.agent_id, name = excluded.name,
          collected_at = COALESCE(excluded.collected_at, agent_cost_sources.collected_at),
          attempted_at = excluded.attempted_at, error = excluded.error,
          missing_by_model = COALESCE(excluded.missing_by_model, agent_cost_sources.missing_by_model)
      `),
    };
  } catch (err) {
    log(`[COSTS] disabled: cannot open ${COSTS_DB_PATH}: ${err.message}`);
    return null;
  }
}

const COSTS_INTERVAL_MS = 5 * 60 * 1000;
const COSTS_FIRST_DELAY_MS = 20_000;
/** Days re-read on every pass: late calls and repriced ones land in the right day. */
const COSTS_WINDOW_DAYS = 30;
/** The most recent sessions kept per pass; older ones stay as last read. */
const COSTS_SESSIONS_LIMIT = 50;
/**
 * OpenClaw answers from an index of its transcripts, rebuilt in the background after a
 * price change or a restart; until then it answers zeros with `cacheStatus` not `fresh`.
 * Such an answer is never stored: ask again a little later, a few times. Measured on a
 * VPS (2026-09-27): about 60 s to rebuild, from 4 to 290 transcript files alike.
 */
const COSTS_FRESH_ATTEMPTS = 6;
const COSTS_FRESH_WAIT_MS = 20_000;
const COSTS_CALL_TIMEOUT_MS = 60_000;

/**
 * Runs `openclaw "$@"` against the agent's own Gateway on port 3000, with the token
 * resolved inside the container as the entrypoint does (lib/agent-devices.ts, same
 * script, kept identical to lib/gateway-cli.ts): it never reaches argv on the host.
 */
const COSTS_GATEWAY_CLI = [
  'export OPENCLAW_GATEWAY_PORT=3000',
  'if [ -f /root/.agent-token ]; then OPENCLAW_GATEWAY_TOKEN=$(head -1 /root/.agent-token | tr -d "[:space:]"); export OPENCLAW_GATEWAY_TOKEN; fi',
  'exec openclaw "$@"',
].join('; ');

const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Why a command failed, in words a person can act on. `openclaw gateway call --json`
 * prints its error as JSON on stdout (`{"ok":false,"error":{"message":…}}`) and exits 1,
 * with stderr often empty; Node's own message is the whole command line. So: the JSON
 * error, else the last stderr line, else the kind of failure — never the argv.
 */
function failureReason(err, stdout, stderr) {
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'answer larger than the read limit';
  if (err.killed) return 'timed out';
  if (err.wrappedExec && execTimeout.isTimeoutExit(err.code)) return execTimeout.timeoutCause(err.code);
  const out = String(stdout || '');
  const start = out.indexOf('{');
  if (start >= 0) {
    try {
      const j = JSON.parse(out.slice(start));
      const m = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : null);
      if (m) return String(m).split('\n')[0];
    } catch { /* not JSON: fall through */ }
  }
  const line = String(stderr || '').trim().split('\n').filter(Boolean).pop();
  return line || `exited with code ${err.code ?? 'unknown'}`;
}

function execFileAsync(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: EXEC_MAX_BUFFER, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) return reject(new Error(failureReason(err, stdout, stderr)));
      resolve(stdout);
    });
  });
}

/**
 * Runs a command INSIDE an agent container, bounded there: `timeout -k 5 N` inside the
 * container (killing only the docker client at the host-side deadline leaves the process running
 * in the agent, and they pile up). The host timer is a few seconds longer. An image without
 * `timeout` is retried once unwrapped and remembered. Rejects with `failureReason`'s text.
 */
async function containerExec(container, argv, timeoutMs, maxBuffer = EXEC_MAX_BUFFER) {
  const run = (wrap) => new Promise((resolve, reject) => {
    execFile('docker', execTimeout.buildExecArgs({ container, argv, timeoutMs, wrap }),
      { timeout: wrap ? execTimeout.clientTimeoutMs(timeoutMs) : timeoutMs, maxBuffer, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (err) {
          err.wrappedExec = wrap;
          err.wrapperMissing = wrap && execTimeout.isWrapperMissing(err.code, `${stdout}\n${stderr}`);
          err.reason = failureReason(err, stdout, stderr);
          return reject(err);
        }
        resolve(stdout);
      });
  });
  const unwrapped = execTimeout.unwrappedContainers();
  if (!unwrapped.has(container)) {
    try {
      return await run(true);
    } catch (e) {
      if (!e.wrapperMissing) throw new Error(e.reason);
      unwrapped.add(container);
    }
  }
  try { return await run(false); } catch (e) { throw new Error(e.reason); }
}

async function gatewayCall(container, method, params) {
  const out = await containerExec(container, ['sh', '-c', COSTS_GATEWAY_CLI, 'sh',
    'gateway', 'call', method, '--json', '--timeout', String(COSTS_CALL_TIMEOUT_MS - 5000), '--params', JSON.stringify(params)],
  COSTS_CALL_TIMEOUT_MS);
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`${method}: no JSON in the answer`);
  return JSON.parse(out.slice(start));
}

/** A Docker container name, as `docker ps` prints it; anything else is never exec'd (one rule: lib/docker-stats.js). */
const CONTAINER_NAME_RE = dockerStats.CONTAINER_NAME_RE;
/**
 * Each field quoted and escaped by Docker itself (`json`, `printf "%q"`), so a display
 * name holding a tab or a newline stays one field of one line. Only AGENT_NAME is read
 * from the environment.
 */
const INSPECT_FORMAT = '{{json .Name}}\t{{json (index .Config.Labels "AGENT_ID")}}\t'
  + '{{range .Config.Env}}{{if eq (index (split . "=") 0) "AGENT_NAME"}}{{printf "%q" .}}{{end}}{{end}}';

function parseQuoted(field) {
  if (!field) return null;
  try { return JSON.parse(field); } catch { return null; }
}

/** Running agent containers with their AGENT_ID and AGENT_NAME. */
async function listRunningAgents() {
  const names = (await execFileAsync('docker', ['ps', '--filter', 'label=AGENT_ID', '--format', '{{.Names}}'], 10_000))
    .split('\n').map((s) => s.trim()).filter((n) => CONTAINER_NAME_RE.test(n));
  if (!names.length) return [];
  let raw;
  try {
    raw = await execFileAsync('docker', ['inspect', '--format', INSPECT_FORMAT, ...names], 10_000);
  } catch {
    // One container removed between `ps` and `inspect` fails the batch: ask one by one.
    const parts = [];
    for (const n of names) {
      parts.push(await execFileAsync('docker', ['inspect', '--format', INSPECT_FORMAT, n], 10_000).catch(() => ''));
    }
    raw = parts.join('\n');
  }
  const agents = raw.split('\n').filter(Boolean).map((line) => {
    const [name, agentId, env] = line.split('\t');
    const container = String(parseQuoted(name) ?? '').replace(/^\//, '');
    const agentName = String(parseQuoted(env) ?? '').replace(/^AGENT_NAME=/, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return { container, agentId: parseQuoted(agentId) || null, name: agentName || null };
  }).filter((a) => CONTAINER_NAME_RE.test(a.container));
  // `docker ps` listed containers but `inspect` told nothing about any of them: Docker is failing, not empty.
  // Throwing makes the caller treat it as unreachable and mark nothing gone.
  if (!agents.length) throw new Error('docker inspect returned nothing for the listed containers');
  return agents;
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * An answer to store: its index is `fresh`, or there is no index to speak of — an agent
 * with nothing in the range answers without `cacheStatus` at all.
 */
function isFresh(answer) {
  const status = answer?.cacheStatus?.status;
  return status === undefined || status === 'fresh';
}

/**
 * The shape the store step relies on. It deletes the 30-day window before inserting, so
 * an answer missing its lists (an error object that somehow exited 0) must never reach
 * it: that would wipe the window and store nothing.
 */
function wellFormed(cost, usage) {
  return cost?.ok !== false && usage?.ok !== false
    && Array.isArray(cost?.daily) && Array.isArray(usage?.sessions)
    && usage?.aggregates !== null && typeof usage?.aggregates === 'object';
}

async function collectAgentCosts(agent) {
  const endDate = utcDate(Date.now());
  const startDate = utcDate(Date.now() - (COSTS_WINDOW_DAYS - 1) * 86_400_000);
  const range = { agentScope: 'all', startDate, endDate };
  let cost = null;
  let usage = null;
  let status = null;
  for (let attempt = 0; attempt < COSTS_FRESH_ATTEMPTS; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, COSTS_FRESH_WAIT_MS));
    cost = await gatewayCall(agent.container, 'usage.cost', range);
    usage = await gatewayCall(agent.container, 'sessions.usage', { ...range, limit: COSTS_SESSIONS_LIMIT });
    if (isFresh(cost) && isFresh(usage)) break;
    status = (isFresh(cost) ? usage : cost)?.cacheStatus?.status ?? null;
    cost = null;
  }
  if (!cost) {
    throw new Error(`OpenClaw's usage index still "${status}" after ${COSTS_FRESH_ATTEMPTS} tries; the previous figures are kept`);
  }
  if (!wellFormed(cost, usage)) throw new Error('unexpected answer from OpenClaw; the previous figures are kept');

  const container = agent.container;
  costs.db.transaction(() => {
    costs.clearDaily.run(container, startDate);
    for (const d of Array.isArray(cost.daily) ? cost.daily : []) {
      if (!num(d.totalTokens) && !num(d.missingCostEntries) && !num(d.totalCost)) continue;
      costs.insertDaily.run({
        container, date: String(d.date),
        input: num(d.input), output: num(d.output), cache_read: num(d.cacheRead), cache_write: num(d.cacheWrite),
        total_tokens: num(d.totalTokens), cost: num(d.totalCost), input_cost: num(d.inputCost),
        output_cost: num(d.outputCost), cache_read_cost: num(d.cacheReadCost), cache_write_cost: num(d.cacheWriteCost),
        missing: num(d.missingCostEntries),
      });
    }
    costs.clearModelDaily.run(container, startDate);
    for (const m of Array.isArray(usage.aggregates?.modelDaily) ? usage.aggregates.modelDaily : []) {
      costs.insertModelDaily.run({
        container, date: String(m.date), provider: String(m.provider ?? 'unknown'), model: String(m.model ?? 'unknown'),
        tokens: num(m.tokens), cost: num(m.cost), calls: num(m.count),
      });
    }
    for (const s of Array.isArray(usage.sessions) ? usage.sessions : []) {
      const u = s.usage || {};
      const id = s.sessionId || u.sessionId || s.key;
      if (!id) continue;
      costs.upsertSession.run({
        container, session_id: String(id), session_key: s.key ?? null, label: s.label ?? null,
        agent_id: s.agentId ?? null, provider: s.modelProvider ?? null, model: s.model ?? null,
        tokens: num(u.totalTokens), cost: num(u.totalCost), missing: num(u.missingCostEntries),
        first_activity: u.firstActivity ?? null, last_activity: u.lastActivity ?? s.updatedAt ?? null,
      });
    }
    costs.upsertSource.run({
      container, agent_id: agent.agentId, name: agent.name, collected_at: Date.now(), attempted_at: Date.now(),
      error: null, missing_by_model: JSON.stringify(cost.totals?.missingCostByModel || {}),
    });
  })();
}

// ── Vendor balances ──
//
// The check against the bill: what the vendor says it charged, next to what the agents'
// OpenClaw priced, over the same interval. Right after a pass of collectCosts — at most
// once an hour — the daemon reads each vendor's own figure and, in the same row, the
// agents' cumulative priced total for that vendor's models. Between two rows the balance
// drop (DeepSeek) or the usage growth (OpenRouter) is what the vendor billed, and the
// agents_cost growth is what the agents priced. Other users of the same key (the
// assistant, clients outside Rev4a) and top-ups show up as a difference; the API names
// both. Read-only calls, never billed.

const BALANCE_INTERVAL_MS = 60 * 60 * 1000;
const BALANCE_RETENTION_MS = 400 * 24 * 3600 * 1000;
const PROVIDER_KEYS_PATH = path.join(DATA_DIR, 'data', 'provider-keys.json');

const VENDOR_BALANCES = {
  /** { currency, balance } — DeepSeek's total balance (topped-up plus granted). */
  deepseek: async (key) => {
    const r = await vendorFetch('https://api.deepseek.com/user/balance', key);
    if (!r.ok) throw new Error(`DeepSeek balance API returned ${r.status}`);
    const j = await r.json();
    const info = (j.balance_infos || []).find((i) => i.currency === 'USD') || (j.balance_infos || [])[0];
    if (!info) throw new Error('DeepSeek returned no balance');
    return { currency: info.currency, balance: Number(info.total_balance), usage: null };
  },
  /** OpenRouter's lifetime usage, which only grows: the cleanest measure of spend. */
  openrouter: async (key) => {
    const r = await vendorFetch('https://openrouter.ai/api/v1/credits', key);
    if (!r.ok) throw new Error(`OpenRouter credits API returned ${r.status}`);
    const d = (await r.json()).data || {};
    return { currency: 'USD', balance: Number(d.total_credits) - Number(d.total_usage), usage: Number(d.total_usage) };
  },
};

/**
 * A request that failed before any HTTP answer (network, invalid header) keeps only its
 * kind: Node's message for an invalid header value quotes the header — the key itself,
 * when a pasted key carries a line break.
 */
async function vendorFetch(url, key) {
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? 'request timed out' : 'request failed (network, or a malformed key)');
  }
}

async function collectVendorBalances() {
  let keys = {};
  try { keys = JSON.parse(fs.readFileSync(PROVIDER_KEYS_PATH, 'utf8')); } catch { return; }
  const ts = Date.now();
  for (const [vendor, read] of Object.entries(VENDOR_BALANCES)) {
    if (!keys[vendor]) continue;
    // Per vendor: one that failed last time is asked again next pass, not next hour.
    const last = costs.lastBalanceTs.get(vendor).ts;
    if (last && Date.now() - last < BALANCE_INTERVAL_MS - 60_000) continue;
    try {
      const b = await read(keys[vendor]);
      if (!Number.isFinite(b.balance)) throw new Error('no numeric balance');
      costs.insertBalance.run({ ts, vendor, currency: b.currency, balance: b.balance, usage: b.usage,
        agents_cost: costs.agentsCostFor.get(vendor).cost });
    } catch (e) {
      log(`[COSTS] ${vendor} balance: ${e.message}`);
    }
  }
  costs.pruneBalances.run(ts - BALANCE_RETENTION_MS);
}

let costsRunning = false;
async function collectCosts() {
  if (!costs || costsRunning) return;
  costsRunning = true;
  try {
    // Before anything that can return early (Docker down): retention must not depend on it.
    try {
      costs.pruneProxyUsage.run(Math.floor((Date.now() - PROXY_USAGE_RETENTION_MS) / 1000));
    } catch (e) {
      log(`[COSTS] proxy usage retention: ${e.message}`);
    }
    let agents;
    try {
      agents = await listRunningAgents();
    } catch (e) {
      log(`[COSTS] Docker unreachable: ${e.message}`);
      return;
    }
    // Wake every agent first: the first call starts its index rebuild, and the rebuilds
    // then run in parallel (about a minute each) instead of one after the other — after a
    // price change every agent rebuilds, and in turn a pass would outlast the interval.
    for (const agent of agents) {
      await gatewayCall(agent.container, 'usage.cost', { agentScope: 'all', startDate: utcDate(Date.now()), endDate: utcDate(Date.now()) })
        .catch(() => { /* the read below reports it */ });
    }
    // Then one agent at a time: each call is a short-lived CLI in that container.
    for (const agent of agents) {
      try {
        await collectAgentCosts(agent);
      } catch (e) {
        costs.upsertSource.run({
          container: agent.container, agent_id: agent.agentId, name: agent.name, collected_at: null,
          attempted_at: Date.now(), error: String(e.message).slice(0, 300), missing_by_model: null,
        });
      }
    }
    // Only after the agents were read, so both sides of the row describe the same moment.
    await collectVendorBalances().catch((e) => log(`[COSTS] balances: ${e.message}`));
  } finally {
    costsRunning = false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Agent sessions (LIN-1) ───────────────────────────────────────────────────
// The daemon keeps a per-container copy of every agent's OpenClaw sessions in events.db
// (agent_sessions, lib/agent-sessions.js). Source: each agent's own Gateway, through
// `sessions.list` (all sessions incl. archived, paged) and, at a lower rate, `cron runs` for the
// runs of each cron job. One call costs 5-12 s per agent (a CLI start-up), so: agents one at a
// time, never overlapping passes, 30 s while something runs, 60 s idle, backing off on failures.
// The host `openclaw` is not read any more. Transitions are computed against the stored row, so a
// restart writes no event. A failed or garbled answer keeps the last state.

const SESSIONS_TICK_MS = 10_000;
const SESSIONS_FIRST_DELAY_MS = 15_000;
const SESSIONS_CRON_RUNS_LIMIT = 20;
const SESSIONS_CRON_JOBS_PER_PASS = 5;
const SESSIONS_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const SESSIONS_RETENTION_BATCH = 5000;
const SESSIONS_STATS_EVERY = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const agentSessionsDdl = (() => {
  try {
    db.exec(agentSessions.CREATE_TABLES_SQL);
    return true;
  } catch (e) {
    console.error(`[SESSIONS] cannot create agent_sessions: ${e.message}`);
    return false;
  }
})();

const sessionCols = agentSessions.ALL_COLUMNS;
const sessionStmts = agentSessionsDdl ? {
  load: db.prepare('SELECT * FROM agent_sessions WHERE container = ?'),
  upsert: db.prepare(`INSERT INTO agent_sessions (${sessionCols.join(', ')}) VALUES (${sessionCols.map((c) => '@' + c).join(', ')})
    ON CONFLICT(container, session_key) DO UPDATE SET ${sessionCols.filter((c) => c !== 'container' && c !== 'session_key').map((c) => `${c} = excluded.${c}`).join(', ')}`),
  touch: db.prepare('UPDATE agent_sessions SET last_seen_at = ? WHERE container = ? AND session_key = ?'),
  gone: db.prepare('UPDATE agent_sessions SET gone_at = ? WHERE container = ? AND session_key = ? AND gone_at IS NULL'),
  goneAll: db.prepare('UPDATE agent_sessions SET gone_at = ? WHERE container = ? AND gone_at IS NULL'),
  bump: db.prepare('UPDATE agent_sessions_meta SET version = version + 1 WHERE id = 1'),
  pruneAll: db.prepare(agentSessions.PRUNE_SQL.sessions),
  pruneCronRuns: db.prepare(agentSessions.PRUNE_SQL.cronRuns),
  pruneCronJobs: db.prepare(agentSessions.PRUNE_SQL.cronJobs),
  pruneCronEvents: db.prepare(agentSessions.PRUNE_SQL.cronEvents),
  storedContainers: db.prepare('SELECT DISTINCT container FROM agent_sessions WHERE gone_at IS NULL'),
} : null;

/** container -> { due, failures, anyRunning, lastError, cronReadAt: Map<jobId, marker>, cronFailed: Map<jobId, { at, failures }>, cronDue } */
const sessionAgents = new Map();
let sessionsRunning = false;
let sessionsTimer = null;
let sessionsPasses = 0;
let sessionsBusyMs = 0;
let sessionsCpuUs = 0;
let sessionsLastRetention = 0;
let sessionsListFailing = false;
let sessionsStartupChecked = false;

function storedSessions(container) {
  const map = new Map();
  for (const r of sessionStmts.load.all(container)) map.set(r.session_key, r);
  return map;
}

/**
 * Writes one diff in a single transaction: upserted rows, events, rows that left the list, and one
 * version bump when anything but last_seen_at changed.
 */
const writeSessionDiff = agentSessionsDdl ? db.transaction((container, diff, now) => {
  for (const { row, changed } of diff.rows) {
    if (changed) sessionStmts.upsert.run(row);
    else sessionStmts.touch.run(now, container, row.session_key);
  }
  for (const key of diff.gone) sessionStmts.gone.run(now, container, key);
  for (const ev of diff.events) {
    insertEvent.run({ ts: ev.ts, session_id: ev.session_key, type: ev.type, data: JSON.stringify(ev.data) });
  }
  if (diff.changed) sessionStmts.bump.run();
}) : null;

const markContainerGone = agentSessionsDdl ? db.transaction((container, now) => {
  const r = sessionStmts.goneAll.run(now, container);
  if (r.changes > 0) sessionStmts.bump.run();
  return r.changes;
}) : null;

async function readCronRuns(container, agentName, jobId) {
  const out = await containerExec(container, ['sh', '-c', COSTS_GATEWAY_CLI, 'sh',
    'cron', 'runs', '--id', jobId, '--limit', String(SESSIONS_CRON_RUNS_LIMIT)], COSTS_CALL_TIMEOUT_MS);
  const start = out.indexOf('{');
  if (start < 0) throw new Error('cron runs: no JSON in the answer');
  const entries = agentSessions.parseCronRuns(JSON.parse(out.slice(start)));
  // Runs older than the cron retention are not stored: retention would delete them again.
  const cutoff = Date.now() - agentSessions.CRON_RETENTION_MS;
  return entries
    .map((e) => agentSessions.mapCronRun(e, jobId, { container, agentName }))
    .filter((r) => r && (r.updated_at === null || r.updated_at >= cutoff));
}

async function collectAgentSessions(agent, state) {
  const ctx = { container: agent.container, agentName: agent.name };
  const { rows, complete } = await agentSessions.readAllSessions(
    (params) => gatewayCall(agent.container, 'sessions.list', params), ctx);
  const now = Date.now();
  const diff = agentSessions.diffSessions(storedSessions(agent.container), rows, now, { complete });
  writeSessionDiff(agent.container, diff, now);
  state.anyRunning = rows.some((r) => r.status === 'running');
  let changed = diff.changed;
  let events = diff.events.length;

  // Cron runs: a few jobs per pass, only those whose job row moved since they were read.
  let storedNow = null;
  const stored = () => (storedNow ??= storedSessions(agent.container));
  if (Date.now() >= state.cronDue) {
    const jobs = agentSessions.cronJobsToRead([...stored().values()], state.cronReadAt, Date.now(), SESSIONS_CRON_JOBS_PER_PASS, state.cronFailed);
    for (const job of jobs) {
      try {
        const runRows = await readCronRuns(agent.container, agent.name, job.jobId);
        const t = Date.now();
        const runDiff = agentSessions.diffSessions(storedSessions(agent.container), runRows, t, { complete: false });
        writeSessionDiff(agent.container, runDiff, t);
        state.cronReadAt.set(job.jobId, job.marker);
        state.cronFailed.delete(job.jobId);
        changed = changed || runDiff.changed;
        events += runDiff.events.length;
      } catch (e) {
        const failures = (state.cronFailed.get(job.jobId)?.failures ?? 0) + 1;
        state.cronFailed.set(job.jobId, { at: Date.now(), failures });
        log(`[SESSIONS] cron runs of ${job.jobId} in ${agent.container}: ${e.message}`);
      }
    }
    if (jobs.length < SESSIONS_CRON_JOBS_PER_PASS) state.cronDue = Date.now() + 5 * 60 * 1000;
  }
  if (changed) db.pragma('wal_checkpoint(PASSIVE)');
  return { rows: rows.length, changed, events };
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Deletes in batches, giving the event loop a turn between batches. */
async function pruneBatches(stmt, cutoff) {
  let n = 0;
  for (;;) {
    const { changes } = stmt.run(cutoff, SESSIONS_RETENTION_BATCH);
    n += changes;
    if (changes < SESSIONS_RETENTION_BATCH) return n;
    await yieldToLoop();
  }
}

async function pruneAgentSessions(now) {
  let n = 0;
  n += await pruneBatches(sessionStmts.pruneAll, now - agentSessions.RETENTION_MS);
  n += await pruneBatches(sessionStmts.pruneCronRuns, now - agentSessions.CRON_RETENTION_MS);
  n += await pruneBatches(sessionStmts.pruneCronJobs, now - agentSessions.CRON_RETENTION_MS);
  await pruneBatches(sessionStmts.pruneCronEvents, now - agentSessions.CRON_RETENTION_MS);
  if (n > 0) {
    sessionStmts.bump.run();
    log(`Sessions retention: ${n} rows deleted`);
  }
  // PASSIVE never waits for readers; the next write moves the rest.
  db.pragma('wal_checkpoint(PASSIVE)');
}

/**
 * Once after start: containers that have live rows but are not running now (stopped or removed
 * while the daemon was down) get gone_at. Compared with the stored rows, not the in-memory map,
 * which is empty after a restart. One container per turn of the event loop.
 */
async function markStoppedContainersGone(live, now) {
  const stored = sessionStmts.storedContainers.all().map((r) => r.container);
  for (const container of agentSessions.containersToMarkGone(stored, live)) {
    try {
      const n = markContainerGone(container, now);
      if (n > 0) log(`[SESSIONS] ${container} is not running: ${n} sessions marked gone`);
    } catch (e) {
      log(`[SESSIONS] could not mark ${container} gone: ${e.message}`);
    }
    await yieldToLoop();
  }
}

async function collectSessions() {
  if (!agentSessionsDdl || sessionsRunning) return;
  sessionsRunning = true;
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  try {
    let agents;
    try {
      agents = await listRunningAgents();
      sessionsListFailing = false;
    } catch (e) {
      if (!sessionsListFailing) log(`[SESSIONS] Docker unreachable: ${e.message}`);
      sessionsListFailing = true;
      return;
    }
    const now = Date.now();
    const live = new Set(agents.map((a) => a.container));
    if (!sessionsStartupChecked) {
      sessionsStartupChecked = true;
      try { await markStoppedContainersGone(live, now); } catch (e) { log(`[SESSIONS] startup check: ${e.message}`); }
    }
    // A container that stopped or was removed keeps its rows and gets gone_at; it is read again once it runs.
    for (const [container, state] of sessionAgents) {
      if (live.has(container)) continue;
      try {
        const n = markContainerGone(container, now);
        if (n > 0) log(`[SESSIONS] ${container} is not running: ${n} sessions marked gone`);
      } catch (e) {
        log(`[SESSIONS] could not mark ${container} gone: ${e.message}`);
      }
      sessionAgents.delete(container);
    }
    for (const agent of agents) {
      let state = sessionAgents.get(agent.container);
      if (!state) {
        state = { due: 0, failures: 0, anyRunning: false, lastError: null, cronReadAt: new Map(), cronFailed: new Map(), cronDue: 0 };
        sessionAgents.set(agent.container, state);
      }
      if (Date.now() < state.due) continue;
      const a0 = Date.now();
      try {
        const res = await collectAgentSessions(agent, state);
        state.failures = 0;
        if (state.lastError) log(`[SESSIONS] ${agent.container} readable again`);
        state.lastError = null;
        if (res.changed) log(`[SESSIONS] ${agent.container}: ${res.rows} sessions, ${res.events} events, ${Date.now() - a0} ms`);
      } catch (e) {
        state.failures += 1;
        if (state.lastError !== e.message) log(`[SESSIONS] ${agent.container}: ${e.message}`);
        state.lastError = e.message;
      }
      state.due = Date.now() + agentSessions.nextDelayMs(state.anyRunning, state.failures);
    }
    if (Date.now() - sessionsLastRetention > SESSIONS_RETENTION_INTERVAL_MS) {
      sessionsLastRetention = Date.now();
      try { await pruneAgentSessions(Date.now()); } catch (e) { log(`[SESSIONS] retention: ${e.message}`); }
    }
  } finally {
    sessionsBusyMs += Date.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    sessionsCpuUs += cpu.user + cpu.system;
    sessionsPasses += 1;
    if (sessionsPasses % SESSIONS_STATS_EVERY === 0) {
      log(`[SESSIONS] ${sessionsPasses} passes: ${Math.round(sessionsBusyMs / sessionsPasses)} ms and ${Math.round(sessionsCpuUs / sessionsPasses / 1000)} ms CPU in the daemon per pass`);
    }
    sessionsRunning = false;
  }
}

function scheduleSessions(delay) {
  sessionsTimer = setTimeout(() => {
    collectSessions()
      .catch((e) => log(`[SESSIONS ERROR] ${e.message}`))
      .finally(() => scheduleSessions(SESSIONS_TICK_MS));
  }, delay);
}

// ── Start ────────────────────────────────────────────────────────────────────

log('Rev4a Daemon starting...');
log(`DB: ${DB_PATH}`);
log('Agent sessions: read from each running agent container, adaptive 30-60 s');

// Agent sessions: the first pass a few seconds after start, then a tick after each finished pass.
scheduleSessions(SESSIONS_FIRST_DELAY_MS);

// Machine metrics: the first sample a few seconds after start (the CPU figure needs a
// delta from the baseline taken at load), then every interval. Off when metrics.db failed.
function sampleMetrics() {
  try { collectSystemMetrics(); } catch (e) { log(`[METRICS ERROR] ${e.message}`); }
}
const FIRST_SAMPLE_DELAY_MS = 5000;
let metricsTimer = null;
const firstSample = metrics
  ? setTimeout(() => { sampleMetrics(); metricsTimer = setInterval(sampleMetrics, METRICS_INTERVAL_MS); }, FIRST_SAMPLE_DELAY_MS)
  : null;
if (metrics) log(`Machine metrics every ${METRICS_INTERVAL_MS / 1000}s into ${METRICS_DB_PATH}`);

// Container consumption: a priming pass, a short wait for the first CPU figure, then every
// interval; the disk Docker holds on a slower timer. Off when metrics.db failed.
function sampleContainers() {
  collectContainerMetrics().catch((e) => log(`[CONTAINERS ERROR] ${e.message}`));
}
function sampleStorage() {
  collectDockerStorage().catch((e) => log(`[CONTAINERS ERROR] ${e.message}`));
}
let containersTimer = null;
let containersPasses = 0;
function scheduleContainers(delay) {
  containersTimer = setTimeout(() => {
    sampleContainers();
    containersPasses++;
    scheduleContainers(containersPasses === 1 ? CONTAINERS_SECOND_DELAY_MS : CONTAINERS_INTERVAL_MS);
  }, delay);
}
let storageTimer = null;
const firstStorage = metrics
  ? setTimeout(() => { sampleStorage(); storageTimer = setInterval(sampleStorage, STORAGE_INTERVAL_MS); }, STORAGE_FIRST_DELAY_MS)
  : null;
if (metrics) {
  scheduleContainers(CONTAINERS_FIRST_DELAY_MS);
  startOomStream();
  log(`Container consumption every ${CONTAINERS_INTERVAL_MS / 1000}s, Docker storage every ${STORAGE_INTERVAL_MS / 60000} min, into ${METRICS_DB_PATH}`);
}

// Agent costs: first pass shortly after start (agents may still be booting), then every
// interval. Off when costs.db failed.
function sampleCosts() {
  collectCosts().catch((e) => log(`[COSTS ERROR] ${e.message}`));
}
let costsTimer = null;
const firstCosts = costs
  ? setTimeout(() => { sampleCosts(); costsTimer = setInterval(sampleCosts, COSTS_INTERVAL_MS); }, COSTS_FIRST_DELAY_MS)
  : null;
if (costs) log(`Agent costs every ${COSTS_INTERVAL_MS / 60000} min into ${COSTS_DB_PATH}`);

// Events retention: delete events older than 30 days. It only needs events.db, so it runs on
// every host: no OpenClaw, no metrics.db, no costs.db required. Not tied to the session poll.
const EVENTS_RETENTION_FIRST_DELAY_MS = 10_000;
const EVENTS_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
// A pass deletes at most this many rows (the first one on a huge table would block the event
// loop for many seconds); while passes keep hitting it, the next one follows after a minute.
const EVENTS_RETENTION_MAX_ROWS = 100_000;
const EVENTS_RETENTION_CATCH_UP_MS = 60 * 1000;
let eventsRetentionTimer = null;
function scheduleEventsRetention(delayMs) {
  eventsRetentionTimer = setTimeout(pruneOldEvents, delayMs);
}
function pruneOldEvents() {
  let next = EVENTS_RETENTION_INTERVAL_MS;
  try {
    const n = pruneEvents(db, Date.now(), { maxRows: EVENTS_RETENTION_MAX_ROWS });
    if (n > 0) log(`Events retention: ${n} events older than ${EVENTS_RETENTION_MS / 86_400_000} days deleted`);
    if (n >= EVENTS_RETENTION_MAX_ROWS) next = EVENTS_RETENTION_CATCH_UP_MS;
  } catch (e) {
    log(`[EVENTS RETENTION ERROR] ${e.message}`);
  }
  scheduleEventsRetention(next);
}
const firstEventsRetention = setTimeout(pruneOldEvents, EVENTS_RETENTION_FIRST_DELAY_MS);

// ── System packages (FEAT-14) ────────────────────────────────────────────────
// An agent's restore of its apt packages runs in the background after each start and writes
// /root/.rev4a/packages-status.json. A package that could not come back stays invisible in
// that file, so every PACKAGES_INTERVAL_MS the daemon reads it for each running agent and
// records one `packages_failed` anomaly per failed run. Read-only; an agent whose image
// predates the recorder has no file and is skipped silently.
const PACKAGES_FIRST_DELAY_MS = 60 * 1000;
const PACKAGES_INTERVAL_MS = 10 * 60 * 1000;
const PACKAGES_READ_TIMEOUT_MS = 5000;
/** A status older than the daemon's start minus this is not alerted: a restart re-alerts an old failure at most once a day. */
const PACKAGES_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PACKAGES_STARTED_AT = Date.now();
const packagesAlerted = new Set();
/** Containers whose status could not be read on the last pass, so each failure is logged once per container. */
const packagesReadFailing = new Set();
let packagesListFailing = false;
let packagesRunning = false;
const PACKAGES_MAX_BUFFER = 1024 * 1024;

/** Runs `cat` in the container with a small buffer; execFileAsync's 32 MB would let an agent make the daemon hold a huge string. */
function readPackagesFile(container) {
  return containerExec(container, ['cat', '/root/.rev4a/packages-status.json'], PACKAGES_READ_TIMEOUT_MS, PACKAGES_MAX_BUFFER);
}

async function collectPackagesStatus() {
  if (packagesRunning) return;
  packagesRunning = true;
  try {
    let agents;
    try {
      agents = await listRunningAgents();
      packagesListFailing = false;
    } catch (e) {
      if (!packagesListFailing) log(`[PACKAGES] could not list the running agents: ${e.message}`);
      packagesListFailing = true;
      return;
    }
    for (const agent of agents) {
      let status = null;
      try {
        status = parsePackagesStatus(await readPackagesFile(agent.container));
        packagesReadFailing.delete(agent.container);
      } catch (e) {
        // "No such file" is what an image without the recorder answers: expected, not logged.
        if (!/No such file/i.test(e.message) && !packagesReadFailing.has(agent.container)) {
          log(`[PACKAGES] could not read the status of ${agent.container}: ${e.message}`);
        }
        packagesReadFailing.add(agent.container);
        continue;
      }
      if (!status || (status.state !== 'failed' && status.state !== 'partial')) continue;
      if (status.at < PACKAGES_STARTED_AT - PACKAGES_MAX_AGE_MS) continue;
      const key = packagesAlertKey(agent.container, status);
      if (packagesAlerted.has(key)) continue;
      const names = splitPackagesFailed(status).packages.map((f) => f.name);
      try {
        recordAnomaly(null, 'packages_failed', names, null, packagesFailureMessage(agent.container, status), { container: agent.container });
        packagesAlerted.add(key);
      } catch (e) {
        log(`[PACKAGES] could not record the alert for ${agent.container}: ${e.message}`);
      }
    }
  } finally {
    packagesRunning = false;
  }
}
function samplePackages() {
  collectPackagesStatus().catch((e) => log(`[PACKAGES ERROR] ${e.message}`));
}
let packagesTimer = null;
const firstPackages = setTimeout(() => { samplePackages(); packagesTimer = setInterval(samplePackages, PACKAGES_INTERVAL_MS); }, PACKAGES_FIRST_DELAY_MS);

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down...');
  clearTimeout(sessionsTimer);
  clearTimeout(firstSample);
  clearInterval(metricsTimer);
  clearTimeout(containersTimer);
  clearTimeout(firstStorage);
  clearInterval(storageTimer);
  clearTimeout(firstCosts);
  clearInterval(costsTimer);
  clearTimeout(firstEventsRetention);
  clearTimeout(eventsRetentionTimer);
  stopOomStream();
  clearTimeout(firstPackages);
  clearInterval(packagesTimer);
  db.close();
  metrics?.db.close();
  costs?.db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received, shutting down...');
  clearTimeout(sessionsTimer);
  clearTimeout(firstSample);
  clearInterval(metricsTimer);
  clearTimeout(containersTimer);
  clearTimeout(firstStorage);
  clearInterval(storageTimer);
  clearTimeout(firstCosts);
  clearInterval(costsTimer);
  clearTimeout(firstEventsRetention);
  clearTimeout(eventsRetentionTimer);
  stopOomStream();
  clearTimeout(firstPackages);
  clearInterval(packagesTimer);
  db.close();
  metrics?.db.close();
  costs?.db.close();
  process.exit(0);
});
