// Read helpers for the lineage table `agent_sessions` in events.db (written by the LIN-1 collector).
// Pure: they take an open better-sqlite3 handle, so tests can pass an in-memory database.
// Every read is defensive: when the table does not exist yet (collector not shipped or not run),
// the answer is empty, never an error.
import type Database from 'better-sqlite3';

export type Session = {
  uid: string;
  container: string;
  agent_name: string | null;
  session_key: string;
  session_id: string | null;
  kind: string | null;
  parent_uid: string | null;
  parent_kind: string | null;
  spawn_depth: number | null;
  label: string | null;
  status: string | null;
  last_error: string | null;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cron_job_id: string | null;
  started_at: number | null;
  updated_at: number | null;
  ended_at: number | null;
  archived_at: number | null;
  gone_at: number | null;
  // Legacy fields kept for the current UI until LIN-3 lands.
  id: string;
  parent_id: string | null;
};

type Row = Record<string, unknown> & { container: string; session_key: string };

export const SESSIONS_CAP = 2000;
export const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000;
const COLUMNS = [
  'container', 'session_key', 'agent_name', 'session_id', 'kind', 'parent_key', 'parent_kind', 'spawn_depth',
  'label', 'status', 'last_error', 'model', 'provider', 'input_tokens', 'output_tokens', 'total_tokens',
  'cost_usd', 'cron_job_id', 'started_at', 'updated_at', 'ended_at', 'archived_at', 'gone_at',
].join(', ');

export function sessionUid(container: string, key: string): string {
  return `${container}|${key}`;
}

function hasSessionsTable(db: Database.Database): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'").get();
  } catch {
    return false;
  }
}

export function sessionsVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT version FROM agent_sessions_meta WHERE id = 1').get() as { version?: number } | undefined;
    return typeof row?.version === 'number' ? row.version : 0;
  } catch {
    return 0;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function toSession(row: Row, parentExists: boolean): Session {
  const parentKey = str(row.parent_key);
  return {
    uid: sessionUid(row.container, row.session_key),
    container: row.container,
    agent_name: str(row.agent_name),
    session_key: row.session_key,
    session_id: str(row.session_id),
    kind: str(row.kind),
    parent_uid: parentKey && parentExists ? sessionUid(row.container, parentKey) : null,
    parent_kind: str(row.parent_kind),
    spawn_depth: num(row.spawn_depth),
    label: str(row.label),
    status: str(row.status),
    last_error: str(row.last_error),
    model: str(row.model),
    provider: str(row.provider),
    input_tokens: num(row.input_tokens),
    output_tokens: num(row.output_tokens),
    total_tokens: num(row.total_tokens),
    cost_usd: num(row.cost_usd), // NULL stays null: unknown is never 0
    cron_job_id: str(row.cron_job_id),
    started_at: num(row.started_at),
    updated_at: num(row.updated_at),
    ended_at: num(row.ended_at),
    archived_at: num(row.archived_at),
    gone_at: num(row.gone_at),
    id: row.session_key,
    parent_id: parentKey,
  };
}

/** Which of the (container, parent_key) pairs exist as rows. Chunked to stay under SQLite's variable limit. */
function existingParents(db: Database.Database, rows: Row[]): Set<string> {
  const pairs = new Map<string, [string, string]>();
  for (const r of rows) {
    const pk = str(r.parent_key);
    if (pk) pairs.set(sessionUid(r.container, pk), [r.container, pk]);
  }
  const found = new Set<string>();
  const all = [...pairs.values()];
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200);
    const sql = `SELECT container, session_key FROM agent_sessions WHERE (container, session_key) IN (${chunk.map(() => '(?, ?)').join(', ')})`;
    const hit = db.prepare(sql).all(...chunk.flat()) as { container: string; session_key: string }[];
    for (const h of hit) found.add(sessionUid(h.container, h.session_key));
  }
  return found;
}

/**
 * Fills cost_usd that the listing left NULL (cron runs never carry one) from costs.db
 * agent_cost_sessions, by (container, session_id). Read-only, bound parameters; the table may be
 * missing (any error leaves the sessions as they are). A cost of 0 is "not priced", so it stays null.
 */
export function fillCostsFromCostsDb(costsDb: Database.Database | null | undefined, sessions: Session[]): Session[] {
  if (!costsDb) return sessions;
  try {
    const wanted = new Map<string, Set<string>>();
    for (const s of sessions) {
      if (s.cost_usd !== null || !s.session_id) continue;
      if (!wanted.has(s.container)) wanted.set(s.container, new Set());
      wanted.get(s.container)!.add(s.session_id);
    }
    if (!wanted.size) return sessions;
    const found = new Map<string, number>();
    for (const [container, ids] of wanted) {
      const all = [...ids];
      for (let i = 0; i < all.length; i += 200) {
        const chunk = all.slice(i, i + 200);
        const sql = `SELECT session_id, cost FROM agent_cost_sessions WHERE container = ? AND session_id IN (${chunk.map(() => '?').join(', ')})`;
        for (const r of costsDb.prepare(sql).all(container, ...chunk) as { session_id: string; cost: number | null }[]) {
          if (typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost > 0) found.set(sessionUid(container, r.session_id), r.cost);
        }
      }
    }
    if (!found.size) return sessions;
    return sessions.map((s) => {
      const cost = s.session_id ? found.get(sessionUid(s.container, s.session_id)) : undefined;
      return cost === undefined ? s : { ...s, cost_usd: cost };
    });
  } catch {
    return sessions;
  }
}

function toSessions(db: Database.Database, rows: Row[], costsDb?: Database.Database | null): Session[] {
  const parents = existingParents(db, rows);
  const sessions = rows.map((r) => {
    const pk = str(r.parent_key);
    return toSession(r, !!pk && parents.has(sessionUid(r.container, pk)));
  });
  return fillCostsFromCostsDb(costsDb, sessions);
}

export type ListOptions = {
  container?: string; since?: number; kind?: string; active?: boolean; limit?: number; now?: number;
  /** Read-only costs.db handle, to price rows the listing left unpriced. Optional. */
  costsDb?: Database.Database | null;
};
export type ListResult = { sessions: Session[]; total: number; version: number; error?: true };

/** Active OR updated in the window (default 7 days); `since` replaces the window; newest first. */
export function listSessions(db: Database.Database, opts: ListOptions = {}): ListResult {
  if (!hasSessionsTable(db)) return { sessions: [], total: 0, version: 0 };
  const now = opts.now ?? Date.now();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.container) { where.push('container = ?'); args.push(opts.container); }
  if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
  const running = "(status = 'running' AND gone_at IS NULL)";
  if (opts.active) {
    where.push(running);
  } else {
    const since = opts.since !== undefined && Number.isFinite(opts.since) ? opts.since : now - DEFAULT_WINDOW_MS;
    where.push(`(${running} OR COALESCE(updated_at, started_at, 0) >= ?)`);
    args.push(since);
  }
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? SESSIONS_CAP) || SESSIONS_CAP, 1), SESSIONS_CAP);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM agent_sessions ${clause}`).get(...args) as { n: number }).n;
    const rows = db
      .prepare(`SELECT ${COLUMNS}, parent_key FROM agent_sessions ${clause} ORDER BY COALESCE(updated_at, started_at, 0) DESC, container, session_key LIMIT ?`)
      .all(...args, limit) as Row[];
    return { sessions: toSessions(db, rows, opts.costsDb), total, version: sessionsVersion(db) };
  } catch {
    // `error` lets a caller tell a failed read from an empty table (the stream keeps its last frame).
    return { sessions: [], total: 0, version: 0, error: true };
  }
}

export type LookupResult =
  | { ok: true; session: Session; children: Session[]; events: Record<string, unknown>[] }
  | { ok: false; status: 400 | 404; error: string };

/**
 * One session by (container, key). With only a key (the old `?id=`), it must be unique across
 * containers: 400 when ambiguous. Children come from parent_key within the same container.
 */
export function getSession(db: Database.Database, q: { container?: string | null; key?: string | null; costsDb?: Database.Database | null }): LookupResult {
  const key = q.key ?? '';
  if (!key) return { ok: false, status: 400, error: 'Missing key' };
  if (!hasSessionsTable(db)) return { ok: false, status: 404, error: 'Not found' };
  try {
    let row: Row | undefined;
    if (q.container) {
      row = db.prepare(`SELECT ${COLUMNS}, parent_key FROM agent_sessions WHERE container = ? AND session_key = ?`).get(q.container, key) as Row | undefined;
    } else {
      const rows = db.prepare(`SELECT ${COLUMNS}, parent_key FROM agent_sessions WHERE session_key = ? LIMIT 2`).all(key) as Row[];
      if (rows.length > 1) {
        return { ok: false, status: 400, error: 'This session key exists in more than one agent container: pass container as well.' };
      }
      row = rows[0];
    }
    if (!row) return { ok: false, status: 404, error: 'Not found' };
    const session = toSessions(db, [row], q.costsDb)[0];
    const childRows = db
      .prepare(`SELECT ${COLUMNS}, parent_key FROM agent_sessions WHERE container = ? AND parent_key = ? ORDER BY COALESCE(updated_at, started_at, 0) DESC LIMIT 50`)
      .all(row.container, key) as Row[];
    let events: Record<string, unknown>[] = [];
    try {
      events = db
        .prepare(`SELECT * FROM events WHERE session_id = ? AND CASE WHEN json_valid(data) THEN json_extract(data, '$.container') END = ? ORDER BY ts DESC LIMIT 20`)
        .all(key, row.container) as Record<string, unknown>[];
    } catch {
      events = [];
    }
    return { ok: true, session, children: toSessions(db, childRows, q.costsDb), events };
  } catch {
    return { ok: false, status: 404, error: 'Not found' };
  }
}

/** True when the sessions frame must be sent: the collector bumped the version since the last frame. */
export function sessionsChanged(lastSent: number | null, version: number): boolean {
  return lastSent === null || version !== lastSent;
}

/** Cheap check for a new-session-state count, used by system health. */
export function sessionsSummary(db: Database.Database): { total: number; latest: number | null } {
  if (!hasSessionsTable(db)) return { total: 0, latest: null };
  try {
    const r = db.prepare('SELECT COUNT(*) AS total, MAX(COALESCE(updated_at, started_at, 0)) AS latest FROM agent_sessions').get() as { total: number; latest: number | null };
    return { total: Number(r.total), latest: r.latest };
  } catch {
    return { total: 0, latest: null };
  }
}

/**
 * Newest events with the session label joined on (container, key). Events without data.container
 * get no label. A row whose `data` is not JSON (the table is shared with older writers) only
 * loses its label; it never fails the query. A read error throws: an empty feed would hide it.
 */
export function recentEvents(db: Database.Database, opts: { limit: number; afterId?: number; ascending?: boolean }): Record<string, unknown>[] {
  // The stream reads ascending after its last id, so it must page by id: events can carry a
  // backdated ts, and a ts order would skip a newer event behind older-dated ones.
  const sort = opts.ascending ? 'e.id ASC' : 'e.ts DESC, e.id DESC';
  const hasTable = hasSessionsTable(db);
  const container = "CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.container') END";
  const sql = hasTable
    ? `SELECT e.*, s.label AS session_label, s.agent_name AS agent_name, ${container} AS container
       FROM events e
       LEFT JOIN agent_sessions s ON s.session_key = e.session_id AND s.container = ${container}
       WHERE e.id > ? ORDER BY ${sort} LIMIT ?`
    : `SELECT e.*, NULL AS session_label, NULL AS agent_name, NULL AS container FROM events e WHERE e.id > ? ORDER BY ${sort} LIMIT ?`;
  return db.prepare(sql).all(opts.afterId ?? 0, opts.limit) as Record<string, unknown>[];
}
