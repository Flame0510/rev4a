// Read helpers for the lineage table `agent_sessions` in events.db (written by the LIN-1 collector).
// Pure: they take an open better-sqlite3 handle, so tests can pass an in-memory database.
// Every read is defensive: when the table does not exist yet (collector not shipped or not run),
// the answer is empty, never an error.
import type Database from 'better-sqlite3';
import { isSubscriptionProvider } from './agent-costs';

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
  /**
   * OpenClaw priced this session under a ChatGPT subscription route (`openai` / `openai-codex`):
   * the UI shows "subscription" instead of a dollar amount. `cost_usd` keeps its value.
   */
  uses_subscription: boolean;
  cron_job_id: string | null;
  started_at: number | null;
  updated_at: number | null;
  ended_at: number | null;
  archived_at: number | null;
  gone_at: number | null;
  // Legacy fields kept for one more release for the current UI.
  id: string;
  parent_id: string | null;
};

type Row = Record<string, unknown> & { container: string; session_key: string };

export const SESSIONS_CAP = 2000;
/** Newest cron runs kept per job in a listing (the rest stay in the table, counted in `total`). */
export const CRON_RUNS_PER_JOB = 20;
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
  const provider = str(row.provider);
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
    provider,
    input_tokens: num(row.input_tokens),
    output_tokens: num(row.output_tokens),
    total_tokens: num(row.total_tokens),
    cost_usd: num(row.cost_usd), // NULL stays null: unknown is never 0
    uses_subscription: isSubscriptionProvider(provider),
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

/** One agent_cost_sessions row as far as this read needs it. `provider` is absent on an older costs.db. */
type CostSessionRow = { session_id: string; cost: number | null; provider?: string | null };

/**
 * Fills cost_usd that the listing left NULL (cron runs never carry one) from costs.db
 * agent_cost_sessions, by (container, session_id), and settles `uses_subscription`: when the session
 * itself has no provider, the row's provider decides. A cost of 0 is "not priced", so it stays null.
 * A price recorded under a subscription provider is never copied into a session that is not a
 * subscription session: that list price is not spend. Read-only, bound parameters; a missing table
 * leaves the sessions as they are, and an older table without the `provider` column is read as
 * before (the session's own provider alone decides).
 */
export function fillCostsFromCostsDb(costsDb: Database.Database | null | undefined, sessions: Session[]): Session[] {
  if (!costsDb) return sessions;
  try {
    // A session is looked up when it may need a price OR when its provider is unknown (the row's
    // provider then decides whether its calls were covered by a subscription).
    const wanted = new Map<string, Set<string>>();
    for (const s of sessions) {
      if (!s.session_id) continue;
      if (s.cost_usd !== null && s.provider !== null) continue;
      if (!wanted.has(s.container)) wanted.set(s.container, new Set());
      wanted.get(s.container)!.add(s.session_id);
    }
    if (!wanted.size) return sessions;
    const found = new Map<string, { cost: number | null; provider: string | null }>();
    for (const [container, ids] of wanted) {
      const all = [...ids];
      for (let i = 0; i < all.length; i += 200) {
        const chunk = all.slice(i, i + 200);
        const inList = chunk.map(() => '?').join(', ');
        let rows: CostSessionRow[];
        try {
          rows = costsDb
            .prepare(`SELECT session_id, cost, provider FROM agent_cost_sessions WHERE container = ? AND session_id IN (${inList})`)
            .all(container, ...chunk) as CostSessionRow[];
        } catch (e) {
          // Only an older costs.db without the provider column reads costs as before; any other error
          // (a busy database) reaches the outer catch, which leaves the sessions as they are.
          if (!/no such column/i.test(String((e as Error)?.message))) throw e;
          rows = costsDb
            .prepare(`SELECT session_id, cost FROM agent_cost_sessions WHERE container = ? AND session_id IN (${inList})`)
            .all(container, ...chunk) as CostSessionRow[];
        }
        for (const r of rows) {
          const cost = typeof r.cost === 'number' && Number.isFinite(r.cost) ? r.cost : null;
          const provider = typeof r.provider === 'string' ? r.provider : null;
          found.set(sessionUid(container, r.session_id), { cost, provider });
        }
      }
    }
    if (!found.size) return sessions;
    return sessions.map((s) => {
      const row = s.session_id ? found.get(sessionUid(s.container, s.session_id)) : undefined;
      if (!row) return s;
      const usesSubscription = s.provider !== null ? isSubscriptionProvider(s.provider) : isSubscriptionProvider(row.provider);
      // A subscription's list price must not become the spend of a paid session.
      const copyCost = row.cost !== null && row.cost > 0 && !(isSubscriptionProvider(row.provider) && !usesSubscription);
      return {
        ...s,
        uses_subscription: usesSubscription,
        cost_usd: s.cost_usd === null && copyCost ? row.cost : s.cost_usd,
      };
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
    const order = 'ORDER BY COALESCE(updated_at, started_at, 0) DESC, container, session_key';
    let rows: Row[];
    if (opts.kind) {
      // An explicit kind filter is a direct question: no per-job trimming.
      rows = db.prepare(`SELECT ${COLUMNS}, parent_key FROM agent_sessions ${clause} ${order} LIMIT ?`).all(...args, limit) as Row[];
    } else {
      // Cron runs (a minutely job leaves ~10k rows a week) must not crowd out the other kinds: the other
      // kinds are read first, then the newest CRON_RUNS_PER_JOB runs of each job fill what is left of the cap.
      const base = clause ? `${clause} AND` : 'WHERE';
      const others = db
        .prepare(`SELECT ${COLUMNS}, parent_key FROM agent_sessions ${base} (kind IS NULL OR kind != 'cron_run') ${order} LIMIT ?`)
        .all(...args, limit) as Row[];
      const room = limit - others.length;
      let cron: Row[] = [];
      if (room > 0) {
        cron = db
          .prepare(
            `SELECT ${COLUMNS}, parent_key FROM (
               SELECT ${COLUMNS}, parent_key,
                 ROW_NUMBER() OVER (PARTITION BY container, COALESCE(cron_job_id, session_key)
                                    ORDER BY COALESCE(updated_at, started_at, 0) DESC, session_key) AS rn
               FROM agent_sessions ${base} kind = 'cron_run'
             ) WHERE rn <= ${CRON_RUNS_PER_JOB} OR (status = 'running' AND gone_at IS NULL) ${order} LIMIT ?`,
          )
          .all(...args, room) as Row[];
      }
      const stamp = (r: Row) => num(r.updated_at) ?? num(r.started_at) ?? 0;
      const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
      rows = [...others, ...cron].sort((p, q) => stamp(q) - stamp(p) || cmp(p.container, q.container) || cmp(p.session_key, q.session_key));
    }
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

/**
 * What the costs.db side of the listing looks like, cheaply (one aggregate, no listing): the stream
 * rebuilds its sessions frame only when this or the collector's version changes. '' without costs.db.
 */
export function costsDbSignature(costsDb: Database.Database | null | undefined): string {
  if (!costsDb) return '';
  try {
    const r = costsDb.prepare('SELECT COUNT(*) AS n, TOTAL(cost) AS s FROM agent_cost_sessions').get() as { n: number; s: number };
    return `${r.n}:${Number(r.s).toFixed(6)}`;
  } catch {
    return '';
  }
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
