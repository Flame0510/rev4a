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
}

export interface JobState {
  insert(agentId: string, ...values: (string | number | null)[]): number;
  update(id: number, fields: Record<string, string | null | undefined>): void;
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
        const now = Date.now();
        const info = db.prepare(
          `INSERT INTO ${table} (${insertColumns.join(', ')})
           VALUES (${insertColumns.map(() => '?').join(', ')})`,
        ).run(agentId, initialStatus, ...values, now, now);
        return Number(info.lastInsertRowid);
      } finally {
        db.close();
      }
    },

    update(id, fields) {
      const entries = Object.entries(fields).filter(([key, value]) => value !== undefined && writable.has(key));
      const now = Date.now();
      const sets = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
      const values: unknown[] = [...entries.map(([, value]) => value), now];
      const status = fields.status;
      if (status && finalStatuses.includes(status)) {
        sets.push('finished_at = ?');
        values.push(now);
      } else if (status) {
        sets.push('finished_at = NULL');
      }
      const db = openDb(false);
      try {
        db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
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
