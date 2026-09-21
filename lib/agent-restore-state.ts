/**
 * Persisted state of agent restores: the `agent_restores` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-restore.ts so busy checks (lib/agent-busy.ts) can ask which
 * agents are being restored without importing the restore action.
 */
import { openDb } from '@/lib/db';

export type RestoreStatus = 'restoring' | 'done' | 'failed' | 'interrupted';

/** Statuses during which the agent must not be touched by anything else. */
export const ACTIVE_RESTORE_STATUSES: readonly RestoreStatus[] = ['restoring'];

export interface AgentRestoreRow {
  id: number;
  agent_id: string;
  status: RestoreStatus;
  file: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

const FINAL: readonly RestoreStatus[] = ['done', 'failed', 'interrupted'];

export function insertRestore(agentId: string, file: string): number {
  const db = openDb(false);
  try {
    const now = Date.now();
    const info = db.prepare(
      `INSERT INTO agent_restores (agent_id, status, file, started_at, updated_at)
       VALUES (?, 'restoring', ?, ?, ?)`,
    ).run(agentId, file, now, now);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

type Writable = Partial<Pick<AgentRestoreRow, 'status' | 'error'>>;

export function updateRestoreRow(id: number, fields: Writable): void {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  const now = Date.now();
  const sets = [...entries.map(([k]) => `${k} = ?`), 'updated_at = ?'];
  const values: unknown[] = [...entries.map(([, v]) => v), now];
  if (fields.status && FINAL.includes(fields.status)) {
    sets.push('finished_at = ?');
    values.push(now);
  } else if (fields.status) {
    sets.push('finished_at = NULL');
  }
  const db = openDb(false);
  try {
    db.prepare(`UPDATE agent_restores SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  } finally {
    db.close();
  }
}

export function latestRestore(agentId: string): AgentRestoreRow | null {
  const db = openDb(true);
  try {
    return (db.prepare('SELECT * FROM agent_restores WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(agentId) as AgentRestoreRow | undefined) ?? null;
  } finally {
    db.close();
  }
}

export function isRestoreActive(agentId: string): boolean {
  const row = latestRestore(agentId);
  return !!row && ACTIVE_RESTORE_STATUSES.includes(row.status);
}

/** AGENT_IDs with a restore in an active status. */
export function activeRestoreAgentIds(): Set<string> {
  const db = openDb(true);
  try {
    const placeholders = ACTIVE_RESTORE_STATUSES.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT DISTINCT agent_id FROM agent_restores WHERE status IN (${placeholders})`).all(...ACTIVE_RESTORE_STATUSES) as { agent_id: string }[];
    return new Set(rows.map((r) => r.agent_id));
  } finally {
    db.close();
  }
}

/**
 * At startup no restore job can be running: a row still active was cut off by the
 * restart. It becomes `interrupted`, keeping the archive it was restoring.
 */
export function markInterruptedRestores(): number {
  const db = openDb(false);
  try {
    const placeholders = ACTIVE_RESTORE_STATUSES.map(() => '?').join(', ');
    const now = Date.now();
    const info = db.prepare(
      `UPDATE agent_restores
         SET error = COALESCE(error, 'Rev4a restarted while this step was running: ' || status),
             status = 'interrupted', updated_at = ?, finished_at = ?
       WHERE status IN (${placeholders})`,
    ).run(now, now, ...ACTIVE_RESTORE_STATUSES);
    return info.changes;
  } finally {
    db.close();
  }
}
