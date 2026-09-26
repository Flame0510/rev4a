#!/usr/bin/env node
/**
 * Rev4a Daemon — SQLite event logger
 * Polls OpenClaw sessions every 30s, writes events to SQLite, and samples the host
 * machine (CPU, RAM, swap, storage) every 30s on a timer of its own.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const { spawnSync, execSync } = require('child_process');
const Database = require('better-sqlite3');
const path = require('path');

// Same rule as lib/rev4a-paths.ts: REV4A_DB, else <data dir>/data/events.db, where the data
// dir is REV4A_DATA_DIR or ~/.config/rev4a — the API reads the files the daemon writes.
const DATA_DIR = process.env.REV4A_DATA_DIR
  || (process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'rev4a')
    : path.join(os.homedir(), '.config', 'rev4a'));
const DB_PATH = process.env.REV4A_DB || path.join(DATA_DIR, 'data', 'events.db');
const POLL_INTERVAL_MS = 30_000;

// Cost rates per 1M tokens (separate in/out pricing)
const MODEL_PRICING = {
  'claude-sonnet-4':  { in: 3.00,  out: 15.00 },
  'claude-opus-4':    { in: 15.00, out: 75.00 },
  'gpt-5-mini':       { in: 0.15,  out: 0.60  },
  'codex':            { in: 3.00,  out: 15.00 },
  'gemini':           { in: 0.075, out: 0.30  },
  'flash':            { in: 0.075, out: 0.30  },
  'deepseek':         { in: 0.55,  out: 2.19  },
  'default':          { in: 3.00,  out: 15.00 },
};

// Direct aliases for models that do not match by substring
const MODEL_ALIASES = {
  'cheap': 'flash',
  'fast':  'claude-sonnet-4',
  'big':   'claude-opus-4',
  'coder': 'codex',
  'pro':   'gemini',
  'reason': 'deepseek',
};


function estimateCost(model, tokensIn, tokensOut) {
  if (!tokensIn && !tokensOut) return 0;
  const m = (model || '').toLowerCase();
  // Check direct aliases first (e.g. 'cheap' → 'flash')
  const aliasKey = Object.keys(MODEL_ALIASES).find(a => m === a || m.endsWith('/' + a));
  const resolved = aliasKey ? MODEL_ALIASES[aliasKey] : null;
  const key = resolved
    || Object.keys(MODEL_PRICING).find(k => k !== 'default' && m.includes(k))
    || 'default';
  const p = MODEL_PRICING[key];
  return ((tokensIn || 0) / 1_000_000 * p.in) + ((tokensOut || 0) / 1_000_000 * p.out);
}

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
    const cost_usd = estimateCost(model, tokens_in, tokens_out);
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
        data: JSON.stringify({ cost_usd, tokens: tokens_in + tokens_out }),
      });
    } else if (prevSnapshot && prevSnapshot.status !== 'error' && status === 'error') {
      pendingEvents.push({
        ts: now,
        session_id,
        type: 'fail',
        data: JSON.stringify({ cost_usd, tokens: tokens_in + tokens_out, reason: 'openclaw_error_signal' }),
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
    // Prevent logging the same timeout multiple times (check if already logged)
    const alreadyLogged = db.prepare(
      `SELECT id FROM events WHERE session_id = ? AND type = 'spawn_timeout' LIMIT 1`
    ).get(session_id);
    if (alreadyLogged) continue;

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

  // Prune knownSessions — delete completed sessions older than 30 days
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  for (const [id, snap] of knownSessions) {
    if (snap.status === 'completed' && snap.updatedAt && snap.updatedAt < cutoff) {
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

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down...');
  clearInterval(timer);
  clearTimeout(firstSample);
  clearInterval(metricsTimer);
  db.close();
  metrics?.db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received, shutting down...');
  clearInterval(timer);
  clearTimeout(firstSample);
  clearInterval(metricsTimer);
  db.close();
  metrics?.db.close();
  process.exit(0);
});
