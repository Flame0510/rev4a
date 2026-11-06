/**
 * The four lifecycle job tables — `agent_upgrades`, `agent_recreates`, `agent_restores`,
 * `agent_edits` — are the same machine: an insert that starts a row in one status, an
 * update that stamps `updated_at` and `finished_at`, a latest lookup, an "is something
 * running" check, an at-startup sweep that turns interrupted rows into `interrupted`, and
 * a retention prune. They used to be four copies of that code, which drifted; this factory
 * is the single implementation, and each table keeps its own types and function names.
 *
 * The table and column names come from this file's callers, never from a request, and
 * `update` only writes the columns its spec allows: nothing user-supplied can reach the
 * generated SQL.
 */
import { openDb } from '@/lib/db';

export class AgentJobBusyError extends Error {
  readonly code = 'REV4A_AGENT_JOB_BUSY';
  constructor() { super('Another lifecycle operation of this agent started; refresh and retry'); }
}

const LIFECYCLE_TABLES = ['agent_upgrades', 'agent_recreates', 'agent_restores', 'agent_edits'] as const;
const ENDED_STATUSES = new Set(['done', 'failed', 'interrupted', 'rolled_back', 'rollback_failed']);

/** Must be checked in the same transaction as every lifecycle claim. */
function assertAgentIdle(db: ReturnType<typeof openDb>, agentId: string): void {
  for (const table of LIFECYCLE_TABLES) {
    const row = db.prepare(`SELECT status${table === 'agent_upgrades' ? ', cron_model_repair_claim' : ''}
      FROM ${table} WHERE agent_id = ? ORDER BY id DESC LIMIT 1`).get(agentId) as { status: string; cron_model_repair_claim?: number | null } | undefined;
    if (row && (!ENDED_STATUSES.has(row.status) || row.cron_model_repair_claim != null)) throw new AgentJobBusyError();
  }
}

/** Reserve the latest update's agent for cron repair without rewriting its result/history. */
export async function claimCronModelRepair(updateId: number): Promise<(() => void) | null> {
  // Cold backups and in-process operations use the shared async ownership check.
  // Do not hold a SQLite transaction while it waits for Docker. The transaction
  // below rechecks persisted owners after that wait, like other lifecycle starters.
  const lookup = openDb(true);
  let agentId: string | undefined;
  try { agentId = (lookup.prepare('SELECT agent_id FROM agent_upgrades WHERE id = ?').get(updateId) as { agent_id: string } | undefined)?.agent_id; }
  finally { lookup.close(); }
  const { agentBusyReason } = await import('@/lib/agent-busy');
  if (!agentId || await agentBusyReason(agentId)) return null;
  const db = openDb(false);
  try {
    const claimed = db.transaction(() => {
      const row = db.prepare(`SELECT agent_id, status FROM agent_upgrades WHERE id = ?
        AND id = (SELECT MAX(u.id) FROM agent_upgrades u WHERE u.agent_id = agent_upgrades.agent_id)`)
        .get(updateId) as { agent_id: string; status: string } | undefined;
      if (!row || !['done', 'failed', 'interrupted'].includes(row.status)) return false;
      try { assertAgentIdle(db, row.agent_id); }
      catch (e) { if (e instanceof AgentJobBusyError) return false; throw e; }
      db.prepare('UPDATE agent_upgrades SET cron_model_repair_claim = 1 WHERE id = ?').run(updateId);
      return true;
    }).immediate();
    if (!claimed) return null;
  } finally { db.close(); }
  return () => {
    const db = openDb(false);
    try { db.prepare('UPDATE agent_upgrades SET cron_model_repair_claim = NULL WHERE id = ?').run(updateId); }
    finally { db.close(); }
  };
}

export interface JobStateSpec {
  /** Table name (created by lib/db-bootstrap.mjs). */
  table: string;
  /** The status an inserted row starts in. */
  initialStatus: string;
  /** Statuses during which the agent must not be touched by anything else. */
  activeStatuses: readonly string[];
  /** Statuses that end a job: `finished_at` is stamped when one is set. */
  finalStatuses: readonly string[];
  /** Extra columns `insert` writes, after agent_id/status/started_at/updated_at. */
  insertColumns: readonly string[];
  /** Extra columns `update` may set, besides status and error. */
  writableColumns: readonly string[];
  /** Additional journal ownership changes committed with the new lifecycle claim. */
  afterInsert?(db: ReturnType<typeof openDb>, agentId: string, id: number): void;
}

export interface JobState {
  insert(agentId: string, ...values: (string | number | null)[]): number;
  update(id: number, fields: Record<string, string | number | null | undefined>): void;
  /** Atomically claim an ended latest row again, refusing any intervening lifecycle owner. */
  reactivate(id: number, expectedStatus: string, fields: Record<string, string | number | null | undefined>): void;
  latest<T>(agentId: string): T | null;
  isActive(agentId: string): boolean;
  activeAgentIds(): Set<string>;
  markInterrupted(): number;
  /** Delete all but the newest `keepPerAgent` rows of each agent. Returns the count. */
  prune(keepPerAgent: number): number;
}

export function createJobState(spec: JobStateSpec): JobState {
  const { table, initialStatus, activeStatuses, finalStatuses } = spec;
  const insertColumns = ['agent_id', 'status', ...spec.insertColumns, 'started_at', 'updated_at'];
  const writable = new Set(['status', 'error', ...spec.writableColumns]);
  const activePlaceholders = activeStatuses.map(() => '?').join(', ');

  const writeUpdate = (db: ReturnType<typeof openDb>, id: number, fields: Record<string, string | number | null | undefined>) => {
    const entries = Object.entries(fields).filter(([key, value]) => value !== undefined && writable.has(key));
    const now = Date.now();
    const sets = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
    const values: unknown[] = [...entries.map(([, value]) => value), now];
    const status = typeof fields.status === 'string' ? fields.status : undefined;
    if (status && finalStatuses.includes(status)) {
      sets.push('finished_at = ?');
      values.push(now);
    } else if (status) {
      sets.push('finished_at = NULL');
    }
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  };

  const latest = <T,>(agentId: string): T | null => {
    const db = openDb(true);
    try {
      return (db.prepare(`SELECT * FROM ${table} WHERE agent_id = ? ORDER BY id DESC LIMIT 1`).get(agentId) as T | undefined) ?? null;
    } finally {
      db.close();
    }
  };

  return {
    insert(agentId, ...values) {
      if (values.length !== spec.insertColumns.length) {
        throw new Error(`${table}: insert expects ${spec.insertColumns.length} value(s), got ${values.length}`);
      }
      const db = openDb(false);
      try {
        // The earlier async busy check can become stale during Docker/image reads.
        // Check and claim in one short write transaction across all lifecycle kinds.
        return db.transaction(() => {
          assertAgentIdle(db, agentId);
          const now = Date.now();
          const info = db.prepare(
            `INSERT INTO ${table} (${insertColumns.join(', ')})
             VALUES (${insertColumns.map(() => '?').join(', ')})`,
          ).run(agentId, initialStatus, ...values, now, now);
          const id = Number(info.lastInsertRowid);
          spec.afterInsert?.(db, agentId, id);
          return id;
        }).immediate();
      } finally {
        db.close();
      }
    },

    update(id, fields) {
      const db = openDb(false);
      try {
        writeUpdate(db, id, fields);
      } finally {
        db.close();
      }
    },

    reactivate(id, expectedStatus, fields) {
      if (!ENDED_STATUSES.has(expectedStatus) || typeof fields.status !== 'string' || !activeStatuses.includes(fields.status)) {
        throw new Error('Invalid lifecycle reactivation');
      }
      const db = openDb(false);
      try {
        db.transaction(() => {
          const current = db.prepare(`SELECT agent_id, status FROM ${table} WHERE id = ?`).get(id) as { agent_id: string; status: string } | undefined;
          if (!current || current.status !== expectedStatus) throw new AgentJobBusyError();
          assertAgentIdle(db, current.agent_id);
          for (const other of LIFECYCLE_TABLES) {
            const latest = db.prepare(`SELECT id, status FROM ${other} WHERE agent_id = ? ORDER BY id DESC LIMIT 1`).get(current.agent_id) as { id: number; status: string } | undefined;
            if ((latest && !ENDED_STATUSES.has(latest.status)) || (other === table && latest?.id !== id)) throw new AgentJobBusyError();
          }
          writeUpdate(db, id, fields);
        }).immediate();
      } finally {
        db.close();
      }
    },

    latest,

    isActive(agentId) {
      const row = latest<{ status: string }>(agentId);
      return !!row && activeStatuses.includes(row.status);
    },

    activeAgentIds() {
      const db = openDb(true);
      try {
        const rows = db.prepare(
          `SELECT DISTINCT agent_id FROM ${table} WHERE status IN (${activePlaceholders})`,
        ).all(...activeStatuses) as { agent_id: string }[];
        return new Set(rows.map((r) => r.agent_id));
      } finally {
        db.close();
      }
    },

    markInterrupted() {
      const db = openDb(false);
      try {
        const now = Date.now();
        const info = db.prepare(
          `UPDATE ${table}
              SET error = COALESCE(error, 'Rev4a restarted while this step was running: ' || status),
                  status = 'interrupted', updated_at = ?, finished_at = ?
            WHERE status IN (${activePlaceholders})`,
        ).run(now, now, ...activeStatuses);
        return info.changes;
      } finally {
        db.close();
      }
    },

    prune(keepPerAgent) {
      const db = openDb(false);
      try {
        const info = db.prepare(
          `DELETE FROM ${table} WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY id DESC) AS rn FROM ${table}
             ) WHERE rn > ?
           )`,
        ).run(keepPerAgent);
        return info.changes;
      } finally {
        db.close();
      }
    },
  };
}
