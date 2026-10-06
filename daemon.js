#!/usr/bin/env node
/**
 * Rev4a Daemon — SQLite event logger
 * Polls OpenClaw sessions every 30s, writes events to SQLite, samples the host machine
 * (CPU, RAM, swap, storage) every 30s, samples what each container consumes every 60s
 * (metrics.db), and every 5 min reads what each running agent spent, as its OpenClaw priced
 * it, into costs.db — each on a timer of its own.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const { spawnSync, execSync, execFile } = require('child_process');
const Database = require('better-sqlite3');
const path = require('path');
// Shared with the dashboard (lib/docker-socket.ts): one copy of where the Docker socket is.
const { dockerRequestJson } = require('./lib/docker-socket-path.js');
const dockerStats = require('./lib/docker-stats.js');
const { EVENTS_RETENTION_MS, pruneEvents } = require('./lib/events-retention.js');
const { createContainerAnomalyDetector } = require('./lib/container-anomalies.js');

// Same rule as lib/rev4a-paths.ts: REV4A_DB, else <data dir>/data/events.db, where the data
// dir is REV4A_DATA_DIR or ~/.config/rev4a — the API reads the files the daemon writes.
const DATA_DIR = process.env.REV4A_DATA_DIR
  || (process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'rev4a')
    : path.join(os.homedir(), '.config', 'rev4a'));
const DB_PATH = process.env.REV4A_DB || path.join(DATA_DIR, 'data', 'events.db');
const POLL_INTERVAL_MS = 30_000;

// No cost is estimated here. What agents spend is priced by each agent's own OpenClaw
// and read by the Agent Costs timer below into costs.db; sessions.cost_usd stays 0.

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

// Prepared statements
const upsertSession = db.prepare(`
  INSERT INTO sessions (session_id, parent_id, label, model, tokens_in, tokens_out, cost_usd, status, task_preview, started_at, ended_at, updated_at, trello_card_url)
  VALUES (@session_id, @parent_id, @label, @model, @tokens_in, @tokens_out, @cost_usd, @status, @task_preview, @started_at, @ended_at, @updated_at, @trello_card_url)
  ON CONFLICT(session_id) DO UPDATE SET
    model = excluded.model,
    tokens_in = excluded.tokens_in,
    tokens_out = excluded.tokens_out,
    cost_usd = excluded.cost_usd,
    status = excluded.status,
    -- Only update updated_at if tokens actually changed (real activity)
    updated_at = CASE
      WHEN excluded.tokens_in != sessions.tokens_in OR excluded.tokens_out != sessions.tokens_out
        OR excluded.status != sessions.status
      THEN excluded.updated_at
      ELSE sessions.updated_at
    END,
    ended_at = CASE
      WHEN excluded.ended_at IS NOT NULL THEN excluded.ended_at
      ELSE sessions.ended_at
    END,
    trello_card_url = COALESCE(excluded.trello_card_url, sessions.trello_card_url),
    -- Update parent_id only if the incoming one is better (not null and not equal to main default)
    parent_id = CASE
      WHEN excluded.parent_id IS NOT NULL AND excluded.parent_id != sessions.parent_id
        AND (sessions.parent_id IS NULL OR sessions.parent_id LIKE '%:main')
      THEN excluded.parent_id
      ELSE sessions.parent_id
    END,
    -- Update label only if the current one is the raw key (not a declared name)
    label = CASE
      WHEN sessions.label IS NULL OR sessions.label LIKE 'agent:%'
      THEN excluded.label
      ELSE sessions.label
    END
`);

const insertEvent = db.prepare(`
  INSERT INTO events (ts, session_id, type, data) VALUES (@ts, @session_id, @type, @data)
`);

const getSession = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);

// Track known sessions across polls
const knownSessions = new Map(); // session_id -> { status, tokens_in, tokens_out }
let pollCount = 0;

// ── System Metrics ───────────────────────────────────────────────────────────
//
// Machine-wide CPU, RAM, swap and storage of the host Rev4a runs on, sampled on their
// own timer (METRICS_INTERVAL_MS) — independent of the OpenClaw session poll, which has
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

/** Write a system_anomaly event. `cooldownKey` limits it to one per ANOMALY_COOLDOWN_MS; null writes it now. */
function recordAnomaly(cooldownKey, metric, values, threshold, message) {
  const nowMs = Date.now();
  if (cooldownKey) {
    if (nowMs - (lastAnomalyAlert[cooldownKey] || 0) <= ANOMALY_COOLDOWN_MS) return;
    lastAnomalyAlert[cooldownKey] = nowMs;
  }
  insertEvent.run({
    ts: nowMs,
    session_id: 'system',
    type: 'system_anomaly',
    data: JSON.stringify({ metric, values, threshold, message }),
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
 * script): it never reaches argv on the host. Arguments stay positional.
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

async function gatewayCall(container, method, params) {
  const out = await execFileAsync('docker', ['exec', container, 'sh', '-c', COSTS_GATEWAY_CLI, 'sh',
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
  return raw.split('\n').filter(Boolean).map((line) => {
    const [name, agentId, env] = line.split('\t');
    const container = String(parseQuoted(name) ?? '').replace(/^\//, '');
    const agentName = String(parseQuoted(env) ?? '').replace(/^AGENT_NAME=/, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return { container, agentId: parseQuoted(agentId) || null, name: agentName || null };
  }).filter((a) => CONTAINER_NAME_RE.test(a.container));
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

function extractTrelloUrl(text) {
  if (!text) return null;
  const m = text.match(/https:\/\/trello\.com\/c\/[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

function parseSessionKey(key) {  // e.g. "agent:website:subagent:abc123" or "agent:website:main"
  if (!key) return { label: key, parent_id: null };
  const parts = key.split(':');
  // agent:<agentId>:main → root session
  // agent:<agentId>:subagent:<uuid> → child session
  if (parts.length >= 3 && parts[2] === 'main') {
    return { label: key, parent_id: null };
  }
  if (parts.length >= 4 && parts[2] === 'subagent') {
    // parent is agent:<agentId>:main
    const parent = `${parts[0]}:${parts[1]}:main`;
    return { label: key, parent_id: parent };
  }
  return { label: key, parent_id: null };
}

function inferStatus(session, prevSnapshot) {
  // Strong failure signals from OpenClaw win immediately.
  if (session.abortedLastRun || session.error || session.result === 'error' || session.status === 'error') return 'error';

  const ageMs = session.ageMs || 0;
  const tokensIn  = session.inputTokens  || 0;
  const tokensOut = session.outputTokens || 0;

  // If tokens changed since last poll → session is actively processing
  if (prevSnapshot) {
    const tokenDelta = (tokensIn + tokensOut) - (prevSnapshot.tokens_in + prevSnapshot.tokens_out);
    if (tokenDelta > 0) return 'working';
  }

  // Updated very recently (< 3 min) and fresh → still active
  if (ageMs < 180_000 && session.totalTokensFresh) return 'working';

  // Updated in last 3–30 min without token change → idle (waiting/paused)
  if (ageMs < 1_800_000) return 'idle';

  // Not updated for > 30 min → completed
  return 'completed';
}

function getOrphanResolution(session, snap, ageMs) {
  const tokens = (session.inputTokens || 0) + (session.outputTokens || 0);
  const kind = String(session.kind || '');
  const hadFailureHints = Boolean(session.abortedLastRun || session.error || session.result === 'error');
  if (hadFailureHints) return 'error';
  if (tokens === 0 && kind === 'spawn-child') return 'error';
  if (snap?.status === 'working' && tokens === 0 && ageMs >= 2 * 60 * 1000) return 'error';
  return 'completed';
}

function orphanEventType(status) {
  return status === 'error' ? 'fail' : 'complete';
}

// ── Main Poll Loop ───────────────────────────────────────────────────────────

let openclawMissing = false;

function pollSessions() {
  // If openclaw is not installed, skip polling entirely
  if (!openclawMissing) {
    try {
      execSync('which openclaw', { stdio: 'ignore', timeout: 3000 });
    } catch {
      openclawMissing = true;
      log('OpenClaw not found — daemon idle (no sessions to poll)');
      return;
    }
  } else {
    return;
  }

  log('Polling OpenClaw sessions...');

  let output;
  {
    const result = spawnSync(
      'openclaw', ['sessions', '--json', '--all-agents'],
      {
        encoding: 'utf8',
        timeout: 25_000,
        killSignal: 'SIGKILL',
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    if (result.error || result.status !== 0) {
      log(`WARN: openclaw sessions failed: ${result.error?.message || '(exit ' + result.status + ')'}`);
      return;
    }
    output = result.stdout;
  }

  let data;
  try {
    // Strip any trailing non-JSON lines (e.g. stray log output from openclaw on stdout)
    // Find the last closing brace of the top-level JSON object
    const jsonEnd = output.lastIndexOf('}');
    const cleanOutput = jsonEnd !== -1 ? output.slice(0, jsonEnd + 1) : output;
    data = JSON.parse(cleanOutput);
  } catch (err) {
    log(`ERROR: Failed to parse JSON: ${err.message}`);
    log(`ERROR: Raw output (first 500 chars): ${output.slice(0, 500)}`);
    return; // graceful: skip this poll cycle, retry next interval
  }

  const sessions = data.sessions || [];
  const now = Date.now();
  let newCount = 0;
  let updatedCount = 0;

  const batchInsertEvents = db.transaction((evts) => {
    for (const evt of evts) insertEvent.run(evt);
  });

  const pendingEvents = [];

  // Load declared lineage (takes priority over key parsing)
  let declaredLineage = {};   // child_id → parent_id
  let declaredNames = {};     // child_id → agent_name
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS lineage (
      child_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      agent_name TEXT,
      declared_at INTEGER NOT NULL
    )`).run();
    try { db.prepare('ALTER TABLE lineage ADD COLUMN agent_name TEXT').run(); } catch(e) {}
    const rows = db.prepare('SELECT child_id, parent_id, agent_name FROM lineage').all();
    for (const r of rows) {
      declaredLineage[r.child_id] = r.parent_id;
      if (r.agent_name) declaredNames[r.child_id] = r.agent_name;
    }
  } catch (e) { /* table not yet created, skip */ }

  for (const s of sessions) {
    const session_id = s.key;

    // Skip Telegram channel/group sessions (multi-user).
    // Keep Telegram direct sessions (agent:<id>:telegram:<account>:direct:...) as root nodes
    // since they are the parent of all sub-agents spawned via Telegram.
    if (session_id.includes(':telegram:') && !session_id.includes(':direct:')) continue;
    const { label, parent_id: inferredParent } = parseSessionKey(s.key);
    // Use parentSessionKey if present, otherwise declared lineage, otherwise inferred (always null now)
    const parent_id = s.parentSessionKey || declaredLineage[session_id] || inferredParent;
    const model = s.model || null;
    const tokens_in = s.inputTokens || 0;
    const tokens_out = s.outputTokens || 0;
    const cost_usd = 0;
    const started_at = s.updatedAt ? s.updatedAt - (s.ageMs || 0) : now;
    const updated_at = s.updatedAt || now;

    const isNew = !knownSessions.has(session_id);
    const prevSnapshot = knownSessions.get(session_id);

    const task_preview_val = s.task || s.task_preview || s.label || null;
    const trello_card_url = extractTrelloUrl(task_preview_val);
    // Use declared name if available, otherwise label from key
    const effectiveLabel = declaredNames[session_id] || label;

    const status = inferStatus(s, prevSnapshot);

    // Fix 1: write ended_at when session transitions to completed/error
    let ended_at = null;
    if (status === 'completed' || status === 'error') {
      // Preserve existing ended_at if already set; otherwise set it now
      const existing = getSession.get(session_id);
      ended_at = (existing && existing.ended_at) ? existing.ended_at : now;
    }

    upsertSession.run({
      session_id,
      parent_id,
      label: effectiveLabel,
      model,
      tokens_in,
      tokens_out,
      cost_usd,
      status,
      task_preview: task_preview_val,
      started_at,
      ended_at,
      updated_at,
      trello_card_url,
    });

    if (isNew) {
      newCount++;
      pendingEvents.push({
        ts: now,
        session_id,
        type: 'spawn',
        data: JSON.stringify({ model, parent_id, tokens: tokens_in + tokens_out }),
      });
    } else if (prevSnapshot && prevSnapshot.status !== 'completed' && status === 'completed') {
      pendingEvents.push({
        ts: now,
        session_id,
        type: 'complete',
        data: JSON.stringify({ tokens: tokens_in + tokens_out }),
      });
    } else if (prevSnapshot && prevSnapshot.status !== 'error' && status === 'error') {
      pendingEvents.push({
        ts: now,
        session_id,
        type: 'fail',
        data: JSON.stringify({ tokens: tokens_in + tokens_out, reason: 'openclaw_error_signal' }),
      });
    }

    knownSessions.set(session_id, {
      status,
      tokens_in,
      tokens_out,
      updatedAt: Date.now(),
      kind: s.kind,
      abortedLastRun: s.abortedLastRun,
      error: s.error,
      result: s.result,
    });
    updatedCount++;
  }

  if (pendingEvents.length > 0) batchInsertEvents(pendingEvents);

  // Auto-close orphan sessions: sessions that were working/idle but disappeared
  // from openclaw sessions for > 5 minutes (10+ poll cycles) → mark as completed/error.
  // Grace period protects against transient poll gaps or partial openclaw output.
  const currentIds = new Set(sessions.filter(s => !s.key.includes(':telegram:')).map(s => s.key));
  const fiveMinAgo = now - 5 * 60 * 1000;
  if (currentIds.size > 0) {
    const orphanCandidates = db.prepare(`
      SELECT session_id, status, updated_at, tokens_in, tokens_out, ended_at
      FROM sessions
      WHERE status IN ('working','idle')
      AND updated_at < ?
      AND session_id NOT IN (${Array.from(currentIds).map(() => '?').join(',')})
    `).all(fiveMinAgo, ...currentIds);
    const orphanEvents = [];
    let orphanCount = 0;
    for (const row of orphanCandidates) {
      const snap = knownSessions.get(row.session_id);
      const resolved = getOrphanResolution({
        inputTokens: row.tokens_in,
        outputTokens: row.tokens_out,
        kind: snap?.kind,
        abortedLastRun: snap?.abortedLastRun,
        error: snap?.error,
        result: snap?.result,
      }, snap, now - Number(row.updated_at || 0));
      const ended_at = row.ended_at || now;
      db.prepare(`UPDATE sessions SET status=?, ended_at=?, updated_at=? WHERE session_id = ?`).run(resolved, ended_at, now, row.session_id);
      orphanEvents.push({
        ts: now,
        session_id: row.session_id,
        type: orphanEventType(resolved),
        data: JSON.stringify({ reason: 'orphan_close', prior_status: row.status, resolved_status: resolved }),
      });
      orphanCount++;
    }
    if (orphanEvents.length > 0) batchInsertEvents(orphanEvents);
    if (orphanCount > 0) log(`Orphan cleanup: ${orphanCount} zombie sessions auto-closed (${orphanEvents.filter(e => e.type === 'fail').length} errors)`);
  }

  // ── Timeout Detection ────────────────────────────────────────────────────
  // Find sub-agents that were 'working' in the last snapshot but are no longer
  // present in the current output and have been missing for more than 10 minutes.
  // These are recorded as 'timeout' in the events table.
  const TIMEOUT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  for (const [session_id, snap] of knownSessions) {
    // Only sub-agents (contain 'subagent' in the key)
    if (!session_id.includes('subagent')) continue;
    // Only if they were working in the last poll
    if (snap.status !== 'working') continue;
    // Only if not present in the current poll
    if (currentIds.has(session_id)) continue;
    // Only if missing long enough
    const missingFor = now - (snap.updatedAt || now);
    if (missingFor < TIMEOUT_THRESHOLD_MS) continue;
    // The snapshot remembers its timeout was logged: events retention prunes the table, so the
    // table alone would log it again every 30 days.
    if (snap.timeoutLogged) continue;
    // Prevent logging the same timeout multiple times (check if already logged)
    const alreadyLogged = db.prepare(
      `SELECT id FROM events WHERE session_id = ? AND type = 'spawn_timeout' LIMIT 1`
    ).get(session_id);
    if (alreadyLogged) { snap.timeoutLogged = true; continue; }

    // Insert timeout event
    insertEvent.run({
      ts: now,
      session_id,
      type: 'spawn_timeout',
      data: JSON.stringify({
        missing_for_ms: missingFor,
        last_status: snap.status,
        message: `Subagent missing for ${Math.round(missingFor / 60000)} min without completing`,
      }),
    });
    snap.timeoutLogged = true;
    log(`[TIMEOUT] ${session_id} missing for ${Math.round(missingFor / 60000)} min`);
  }

  // Force names and parents declared via lineage — overrides any previous label, including the generic placeholder older data carries
  const updateLabel = db.prepare('UPDATE sessions SET label = ?, parent_id = ? WHERE session_id = ?');
  const applyLineage = db.transaction(() => {
    for (const [child_id, agent_name] of Object.entries(declaredNames)) {
      const parent_id = declaredLineage[child_id] || null;
      updateLabel.run(agent_name, parent_id, child_id);
    }
  });
  applyLineage();

  log(`Poll done: ${sessions.length} sessions (${newCount} new, ${updatedCount} updated, ${pendingEvents.length} events written)`);

  // Force WAL checkpoint so the VPS reads updated data from the main file
  db.pragma('wal_checkpoint(PASSIVE)');

  // Retention policy: delete cron sessions older than 7 days
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const r1 = db.prepare(`DELETE FROM sessions WHERE session_id LIKE '%:cron:%' AND status = 'completed' AND updated_at < ?`).run(sevenDaysAgo);
  const r2 = db.prepare(`DELETE FROM events WHERE session_id LIKE '%:cron:%' AND ts < ?`).run(sevenDaysAgo);
  if (r1.changes > 0 || r2.changes > 0) {
    log(`Retention cleanup: ${r1.changes} cron sessions, ${r2.changes} cron events deleted`);
  }

  // Prune knownSessions — delete completed sessions, and vanished ones whose timeout was logged, older than 30 days
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  for (const [id, snap] of knownSessions) {
    if ((snap.status === 'completed' || snap.timeoutLogged) && snap.updatedAt && snap.updatedAt < cutoff) {
      knownSessions.delete(id);
    }
  }

  // FULL WAL checkpoint every 10 polls
  pollCount = (pollCount || 0) + 1;
  if (pollCount % 10 === 0) {
    db.pragma('wal_checkpoint(FULL)');
    log(`WAL checkpoint FULL executed (poll #${pollCount})`);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

log('Rev4a Daemon starting...');
log(`DB: ${DB_PATH}`);
log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

// Run immediately, then on interval
pollSessions();
const timer = setInterval(pollSessions, POLL_INTERVAL_MS);

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

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down...');
  clearInterval(timer);
  clearTimeout(firstSample);
  clearInterval(metricsTimer);
  clearTimeout(containersTimer);
  clearTimeout(firstStorage);
  clearInterval(storageTimer);
  clearTimeout(firstCosts);
  clearInterval(costsTimer);
  clearTimeout(firstEventsRetention);
  clearTimeout(eventsRetentionTimer);
  db.close();
  metrics?.db.close();
  costs?.db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received, shutting down...');
  clearInterval(timer);
  clearTimeout(firstSample);
  clearInterval(metricsTimer);
  clearTimeout(containersTimer);
  clearTimeout(firstStorage);
  clearInterval(storageTimer);
  clearTimeout(firstCosts);
  clearInterval(costsTimer);
  clearTimeout(firstEventsRetention);
  clearTimeout(eventsRetentionTimer);
  db.close();
  metrics?.db.close();
  costs?.db.close();
  process.exit(0);
});
