'use strict';

/**
 * agent_sessions: a per-container copy of every agent's OpenClaw sessions, kept in events.db by
 * the daemon (the collector in daemon.js) and read by the dashboard. This file holds the parts
 * that need no Docker: the DDL, the mapping from OpenClaw's answers to rows, and the diff that
 * decides which rows changed and which events are real transitions. Plain CommonJS so daemon.js
 * can require it, like lib/proxy-usage.js.
 *
 * Rules the code below keeps:
 *  - Transitions are computed against the STORED row, never an in-memory map, so a daemon
 *    restart writes nothing new.
 *  - A garbled or partial answer throws before anything is written. An answer is never read as
 *    "the agent has no sessions" unless it says so (totalCount 0).
 *  - "Row left the list" (gone_at) is only decided from a complete listing.
 */

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  container TEXT NOT NULL,
  session_key TEXT NOT NULL,
  agent_name TEXT,
  session_id TEXT,
  kind TEXT,
  parent_key TEXT,
  parent_kind TEXT,
  spawn_depth INTEGER,
  label TEXT,
  status TEXT,
  last_error TEXT,
  model TEXT,
  provider TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  context_tokens INTEGER,
  cost_usd REAL,
  cron_job_id TEXT,
  started_at INTEGER,
  updated_at INTEGER,
  ended_at INTEGER,
  archived_at INTEGER,
  last_seen_at INTEGER,
  gone_at INTEGER,
  PRIMARY KEY (container, session_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(container, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent ON agent_sessions(container, parent_key);

CREATE TABLE IF NOT EXISTS agent_sessions_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
INSERT OR IGNORE INTO agent_sessions_meta (id, version) VALUES (1, 1);
`;

/** Columns compared to decide that a row changed. last_seen_at is deliberately absent. */
const CONTENT_COLUMNS = [
  'agent_name', 'session_id', 'kind', 'parent_key', 'parent_kind', 'spawn_depth', 'label', 'status',
  'last_error', 'model', 'provider', 'input_tokens', 'output_tokens', 'total_tokens', 'context_tokens', 'cost_usd',
  'cron_job_id', 'started_at', 'updated_at', 'ended_at', 'archived_at', 'gone_at',
];

const ALL_COLUMNS = ['container', 'session_key', ...CONTENT_COLUMNS, 'last_seen_at'];

const TERMINAL = new Set(['done', 'failed', 'aborted']);
/** A newly seen row older than this wrote no start event: it was found, not seen starting. */
const FRESH_EVENT_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;
const CRON_RETENTION_MS = 7 * DAY_MS;
const MAX_PAGES = 10;
const PAGE_LIMIT = 200;

const KEY_RE = /^agent:main:/;
const CRON_JOB_RE = /^agent:[^:]+:cron:([^:]+)/;
const CRON_ROOT_RE = /^agent:[^:]+:cron:([^:]+)$/;
const CRON_RUN_KEY_RE = /^agent:[^:]+:cron:[^:]+:run:[^:]+$/;
const JOB_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (isNum(v) ? v : null);
const intOrNull = (v) => (isNum(v) ? Math.trunc(v) : null);
const strOrNull = (v, max = 500) => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);

function cronJobIdOf(key) {
  const m = typeof key === 'string' ? CRON_JOB_RE.exec(key) : null;
  return m ? m[1] : null;
}

/** The job id of a cron job's own row (agent:main:cron:<jobId>), null for any other key. */
function cronRootJobId(key) {
  const m = typeof key === 'string' ? CRON_ROOT_RE.exec(key) : null;
  return m ? m[1] : null;
}

function kindFromKey(key) {
  const rest = String(key).split(':').slice(2);
  if (rest[0] === 'main' && rest.length === 1) return 'main';
  if (rest[0] === 'subagent') return 'subagent';
  if (rest[0] === 'cron') return rest[2] === 'run' ? 'cron_run' : 'cron';
  if (rest[0] === 'dashboard') return 'dashboard';
  if (rest[0] === 'explicit') return 'explicit';
  return 'direct';
}

/** OpenClaw's words to ours: running|done|failed|aborted|''. */
function normalizeStatus(raw, flags = {}) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (flags.hasActiveRun || s === 'running') return 'running';
  if (flags.aborted) return 'aborted';
  if (s === 'done' || s === 'completed' || s === 'complete' || s === 'ok' || s === 'success' || s === 'succeeded') return 'done';
  if (s === 'failed' || s === 'error' || s === 'timeout' || s === 'timed_out') return 'failed';
  if (s === 'aborted' || s === 'killed' || s === 'cancelled' || s === 'canceled') return 'aborted';
  return '';
}

/**
 * One row of an RPC sessions.list answer to a stored row; null when it is not a session of the
 * `main` OpenClaw agent (only that one is kept) or has no usable key.
 */
function mapListRow(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const key = raw.key;
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  const spawnedBy = strOrNull(raw.spawnedBy, 300);
  const parentSessionKey = strOrNull(raw.parentSessionKey, 300);
  const parentKey = spawnedBy || parentSessionKey;
  return {
    container: ctx.container,
    session_key: key,
    agent_name: ctx.agentName ?? null,
    session_id: strOrNull(raw.sessionId, 200),
    kind: strOrNull(raw.classification, 40) || kindFromKey(key),
    parent_key: parentKey,
    parent_kind: parentKey ? (spawnedBy ? 'spawn' : 'nav') : 'nav',
    spawn_depth: intOrNull(raw.spawnDepth),
    label: strOrNull(raw.label, 300) || strOrNull(raw.displayName, 300),
    status: normalizeStatus(raw.status, { aborted: raw.abortedLastRun === true, hasActiveRun: raw.hasActiveRun === true }),
    last_error: strOrNull(raw.lastRunError),
    model: strOrNull(raw.model, 200),
    provider: strOrNull(raw.modelProvider, 100) || strOrNull(raw.provider, 100),
    input_tokens: intOrNull(raw.inputTokens),
    output_tokens: intOrNull(raw.outputTokens),
    total_tokens: intOrNull(raw.totalTokens),
    // The model's context window for this session; the spend alarms compare total_tokens against it (lib/spend-alerts.js).
    context_tokens: intOrNull(raw.contextTokens),
    cost_usd: numOrNull(raw.estimatedCostUsd),
    cron_job_id: cronJobIdOf(key),
    started_at: intOrNull(raw.startedAt) ?? intOrNull(raw.createdAt) ?? intOrNull(raw.sessionStartedAt),
    updated_at: intOrNull(raw.updatedAt) ?? intOrNull(raw.lastActivityAt),
    ended_at: intOrNull(raw.endedAt),
    archived_at: intOrNull(raw.archivedAt),
  };
}

/**
 * One page of a sessions.list answer. Throws on anything that is not the expected shape, so the
 * caller writes nothing.
 */
function parseListPage(answer) {
  if (!answer || typeof answer !== 'object' || answer.ok === false || !Array.isArray(answer.sessions)) {
    throw new Error('sessions.list: unexpected answer');
  }
  const nextOffset = isNum(answer.nextOffset) ? answer.nextOffset : null;
  const hasMore = answer.hasMore === true;
  if (hasMore && nextOffset === null) throw new Error('sessions.list: hasMore without nextOffset');
  return {
    sessions: answer.sessions,
    hasMore,
    nextOffset,
    // Only totalCount says how many sessions exist; `count` is the number of rows in this answer.
    totalCount: isNum(answer.totalCount) ? answer.totalCount : null,
  };
}

/**
 * Reads the whole list through `fetchPage(params)`; resolves { rows, complete } or throws.
 * complete is true only when the listing reached its end and agrees with totalCount.
 */
async function readAllSessions(fetchPage, ctx) {
  const byKey = new Map();
  let offset = 0;
  let total = null;
  let hasMore = true;
  let pages = 0;
  let received = 0;
  // Distinct raw keys across pages: a list that shifts between pages (a session moving to the
  // top, a deletion, a server ignoring offset) repeats rows, and repeated rows must not count.
  const seen = new Set();
  let keyless = 0;
  while (hasMore && pages < MAX_PAGES) {
    const params = { limit: PAGE_LIMIT, archived: 'all' };
    if (offset) params.offset = offset;
    const page = parseListPage(await fetchPage(params));
    pages += 1;
    // The largest totalCount seen: a session deleted after page 1 leaves a hole in a later page.
    if (page.totalCount !== null) total = total === null ? page.totalCount : Math.max(total, page.totalCount);
    received += page.sessions.length;
    for (const raw of page.sessions) {
      if (raw && typeof raw.key === 'string') seen.add(raw.key);
      else keyless += 1;
      const row = mapListRow(raw, ctx);
      if (row) byKey.set(row.session_key, row);
    }
    hasMore = page.hasMore;
    if (hasMore) {
      if (page.nextOffset <= offset) throw new Error('sessions.list: paging does not advance');
      offset = page.nextOffset;
    }
  }
  const rows = [...byKey.values()];
  // An empty answer is only believed when the agent says totalCount 0. Rows of other OpenClaw
  // agent ids are dropped by mapListRow, but they still count as an answer: an agent whose only
  // sessions belong to another agent id is empty, not broken.
  if (received === 0 && total !== 0) throw new Error('sessions.list: empty answer without totalCount 0');
  // Complete = the listing ended AND the distinct keys reach the agent's own count. Without a
  // totalCount there is no way to tell, so nothing is marked gone.
  const complete = !hasMore && total !== null && seen.size + keyless >= total;
  return { rows, complete };
}

/** Entries of a `cron runs` answer; throws when it has no entries array. */
function parseCronRuns(answer) {
  if (!answer || typeof answer !== 'object' || answer.ok === false || !Array.isArray(answer.entries)) {
    throw new Error('cron runs: unexpected answer');
  }
  return answer.entries;
}

function validJobId(id) {
  return typeof id === 'string' && JOB_ID_RE.test(id);
}

/** One `cron runs` entry to a cron_run row; null for entries that are not a finished run with a sessionId. */
function mapCronRun(entry, jobId, ctx) {
  if (!entry || typeof entry !== 'object' || !validJobId(jobId)) return null;
  const sessionId = strOrNull(entry.sessionId, 200);
  if (!sessionId) return null;
  if (typeof entry.action === 'string' && entry.action !== 'finished') return null;
  const key = typeof entry.sessionKey === 'string' && CRON_RUN_KEY_RE.test(entry.sessionKey)
    ? entry.sessionKey
    : `agent:main:cron:${jobId}:run:${sessionId}`;
  if (!KEY_RE.test(key)) return null;
  const startedAt = intOrNull(entry.runAtMs);
  const duration = intOrNull(entry.durationMs);
  const endedAt = startedAt !== null && duration !== null ? startedAt + duration : intOrNull(entry.ts);
  const usage = entry.usage && typeof entry.usage === 'object' ? entry.usage : {};
  const completion = typeof entry.completionStatus === 'string' ? entry.completionStatus : null;
  let status = normalizeStatus(entry.status);
  if (status === 'done' && completion && normalizeStatus(completion) === 'failed') status = 'failed';
  return {
    container: ctx.container,
    session_key: key,
    agent_name: ctx.agentName ?? null,
    session_id: sessionId,
    kind: 'cron_run',
    parent_key: `agent:main:cron:${jobId}`,
    parent_kind: 'cron',
    spawn_depth: null,
    label: null,
    status,
    last_error: strOrNull(entry.error),
    model: strOrNull(entry.model, 200),
    provider: strOrNull(entry.provider, 100),
    input_tokens: intOrNull(usage.input_tokens ?? usage.input),
    output_tokens: intOrNull(usage.output_tokens ?? usage.output),
    total_tokens: intOrNull(usage.total_tokens ?? usage.total ?? usage.totalTokens),
    context_tokens: null,
    cost_usd: null,
    cron_job_id: jobId,
    started_at: startedAt,
    updated_at: endedAt ?? startedAt,
    ended_at: status === 'running' ? null : endedAt,
    archived_at: null,
  };
}

const same = (a, b) => (a ?? null) === (b ?? null);

function latestTime(row) {
  const t = [row.started_at, row.updated_at, row.ended_at].filter(isNum);
  return t.length ? Math.max(...t) : null;
}

/** The events one row's change writes, computed against its stored form (null = never seen). */
function transitionEvents(prev, next, now, freshMs = FRESH_EVENT_MS) {
  const events = [];
  const base = () => ({
    container: next.container,
    agent_name: next.agent_name,
    session_key: next.session_key,
    kind: next.kind,
    label: next.label,
    model: next.model,
  });
  const push = (type, ts, extra) => events.push({
    ts: Math.min(isNum(ts) ? ts : now, now),
    session_key: next.session_key,
    type,
    data: { ...base(), parent_key: next.parent_key, status: next.status, ...(extra || {}) },
  });
  // A cron job's own row (agent:main:cron:<jobId>) moves with every run; the run row writes the
  // events, so a run is one event, not two.
  if (next.kind === 'cron' || cronRootJobId(next.session_key)) return events;
  const terminalType = { done: 'session_ended', failed: 'session_failed', aborted: 'session_aborted' }[next.status];
  const errorExtra = next.last_error ? { error: next.last_error } : undefined;
  if (!prev) {
    const latest = latestTime(next);
    if (latest === null || now - latest > freshMs) return events;
    push('session_started', next.started_at);
    if (next.parent_kind === 'spawn' && next.parent_key) push('subagent_spawned', next.started_at);
    if (terminalType) push(terminalType, next.ended_at ?? next.updated_at, errorExtra);
    return events;
  }
  if (terminalType && prev.status !== next.status) {
    push(terminalType, next.ended_at ?? next.updated_at, errorExtra);
  } else if (next.status === 'running' && prev.status !== 'running') {
    // A new turn on a session that had finished or never ran (agent:main:main answers again).
    push('session_started', next.updated_at ?? next.started_at);
  }
  return events;
}

/**
 * Compares the incoming rows with the stored ones (a Map session_key -> row, for ONE container).
 * Returns what to write: rows (each with `changed`), events, the keys that left the list
 * (only when `complete`), and whether anything but last_seen_at changed.
 */
function diffSessions(stored, incoming, now, opts = {}) {
  const freshMs = opts.freshMs ?? FRESH_EVENT_MS;
  const rows = [];
  const events = [];
  const seen = new Set();
  let changedAny = false;
  for (const next of incoming) {
    seen.add(next.session_key);
    const prev = stored.get(next.session_key) || null;
    const merged = {
      ...next,
      started_at: next.started_at ?? (prev ? prev.started_at : null) ?? null,
      gone_at: null,
      last_seen_at: now,
    };
    const changed = !prev || CONTENT_COLUMNS.some((c) => !same(prev[c], merged[c]));
    if (changed) changedAny = true;
    events.push(...transitionEvents(prev, merged, now, freshMs));
    rows.push({ row: merged, changed });
  }
  const gone = [];
  if (opts.complete) {
    for (const [key, prev] of stored) {
      if (seen.has(key) || prev.gone_at != null || prev.kind === 'cron_run') continue;
      gone.push(key);
    }
    if (gone.length) changedAny = true;
  }
  return { rows, events, gone, changed: changedAny };
}

const CRON_BACKOFF_START_MS = 5 * 60 * 1000;
const CRON_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/** How long a cron job whose `cron runs` failed `failures` times in a row is left alone: 5 min, doubling, 6 h at most. */
function cronBackoffMs(failures) {
  const n = Math.max(1, Math.floor(Number(failures)) || 1);
  return Math.min(CRON_BACKOFF_START_MS * 2 ** Math.min(n - 1, 20), CRON_BACKOFF_MAX_MS);
}

/**
 * Cron job ids worth reading runs for: job rows touched within the retention window and not read at that
 * update. `failed` (jobId -> { at, failures }) holds the jobs whose last read failed: they wait out their
 * backoff, so a job that keeps failing cannot starve the others. Jobs never read come first, then the
 * oldest read.
 */
function cronJobsToRead(storedRows, readAt, now, max, failed) {
  const out = [];
  for (const r of storedRows) {
    const jobId = cronRootJobId(r.session_key);
    if (!jobId || !validJobId(jobId) || r.gone_at != null) continue;
    if (isNum(r.updated_at) && now - r.updated_at > CRON_RETENTION_MS) continue;
    const marker = r.updated_at ?? 0;
    if (readAt.has(jobId) && readAt.get(jobId) >= marker) continue;
    const fail = failed && typeof failed.get === 'function' ? failed.get(jobId) : null;
    if (fail && isNum(fail.at) && now < fail.at + cronBackoffMs(fail.failures)) continue;
    out.push({ jobId, marker, readMarker: readAt.has(jobId) ? readAt.get(jobId) : null });
  }
  out.sort((a, b) => {
    if (a.readMarker === null && b.readMarker !== null) return -1;
    if (a.readMarker !== null && b.readMarker === null) return 1;
    return (a.readMarker ?? 0) - (b.readMarker ?? 0);
  });
  return out.slice(0, max).map(({ jobId, marker }) => ({ jobId, marker }));
}

/**
 * Retention statements (one per table), each with two parameters: cutoff, batch size.
 *  - agent_sessions: by last_seen_at, which every pass that still lists the row refreshes, so a
 *    row the agent still returns is never deleted (an idle main from 31 days ago stays).
 *  - cron runs come from `cron runs`, not the listing: by their own updated_at (7 days).
 *  - events: only the event types this collector writes; older events are left to the 30-day rule.
 */
const PRUNE_SQL = {
  sessions: 'DELETE FROM agent_sessions WHERE rowid IN (SELECT rowid FROM agent_sessions WHERE COALESCE(last_seen_at, updated_at, 0) < ? LIMIT ?)',
  cronRuns: "DELETE FROM agent_sessions WHERE rowid IN (SELECT rowid FROM agent_sessions WHERE kind = 'cron_run' AND COALESCE(updated_at, last_seen_at, 0) < ? LIMIT ?)",
  cronJobs: "DELETE FROM agent_sessions WHERE rowid IN (SELECT rowid FROM agent_sessions WHERE kind = 'cron' AND COALESCE(last_seen_at, updated_at, 0) < ? LIMIT ?)",
  cronEvents: "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE session_id LIKE '%:cron:%' AND (type LIKE 'session\\_%' ESCAPE '\\' OR type = 'subagent_spawned') AND ts < ? LIMIT ?)",
};

/** Containers that have rows not yet marked gone but are not running now (checked once at start). */
function containersToMarkGone(storedContainers, liveContainers) {
  const live = new Set(liveContainers);
  return [...new Set(storedContainers)].filter((c) => typeof c === 'string' && c && !live.has(c));
}

const RUNNING_DELAY_MS = 30 * 1000;
const IDLE_DELAY_MS = 60 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

/** Delay before an agent is read again: 30 s while something runs, 60 s idle, doubling (to 10 min) per consecutive failure. */
function nextDelayMs(anyRunning, failures = 0) {
  if (failures > 0) return Math.min(IDLE_DELAY_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS);
  return anyRunning ? RUNNING_DELAY_MS : IDLE_DELAY_MS;
}

/** Columns added after the table first shipped: an existing database gets them once (guarded ADD COLUMN). */
const ADDED_COLUMNS = [['context_tokens', 'INTEGER']];

/** Adds the missing ADDED_COLUMNS to an existing agent_sessions table. Writes nothing when it is complete. */
function ensureAddedColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(agent_sessions)').all().map((c) => c.name));
  for (const [name, type] of ADDED_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE agent_sessions ADD COLUMN ${name} ${type}`);
  }
}

module.exports = {
  ADDED_COLUMNS,
  ensureAddedColumns,
  CREATE_TABLES_SQL,
  CONTENT_COLUMNS,
  ALL_COLUMNS,
  TERMINAL,
  FRESH_EVENT_MS,
  RETENTION_MS,
  CRON_RETENTION_MS,
  PAGE_LIMIT,
  MAX_PAGES,
  cronJobIdOf,
  cronRootJobId,
  kindFromKey,
  normalizeStatus,
  mapListRow,
  parseListPage,
  readAllSessions,
  parseCronRuns,
  validJobId,
  mapCronRun,
  transitionEvents,
  diffSessions,
  cronJobsToRead,
  cronBackoffMs,
  nextDelayMs,
  PRUNE_SQL,
  containersToMarkGone,
};
