/**
 * Persisted state of agent recreates: the `agent_recreates` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-recreate.ts so busy checks (lib/agent-busy.ts, the provider
 * sync) can ask which agents are being recreated without importing the recreate action.
 */
import { openDb } from '@/lib/db';

export type RecreateStatus = 'backing_up' | 'recreating' | 'done' | 'failed' | 'interrupted';

/** Statuses during which the agent must not be touched by anything else. */
export const ACTIVE_RECREATE_STATUSES: readonly RecreateStatus[] = ['backing_up', 'recreating'];

export interface AgentRecreateRow {
  id: number;
  agent_id: string;
  status: RecreateStatus;
  image: string | null;
  backup_file: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

const FINAL: readonly RecreateStatus[] = ['done', 'failed', 'interrupted'];

export function insertRecreate(agentId: string, image: string): number {
  const db = openDb(false);
  try {
    const now = Date.now();
    const info = db.prepare(
      `INSERT INTO agent_recreates (agent_id, status, image, started_at, updated_at)
       VALUES (?, 'backing_up', ?, ?, ?)`,
    ).run(agentId, image, now, now);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

type Writable = Partial<Pick<AgentRecreateRow, 'status' | 'backup_file' | 'error'>>;

export function updateRecreateRow(id: number, fields: Writable): void {
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
    db.prepare(`UPDATE agent_recreates SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  } finally {
    db.close();
  }
}

export function latestRecreate(agentId: string): AgentRecreateRow | null {
  const db = openDb(true);
  try {
    return (db.prepare('SELECT * FROM agent_recreates WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(agentId) as AgentRecreateRow | undefined) ?? null;
  } finally {
    db.close();
  }
}

export function isRecreateActive(agentId: string): boolean {
  const row = latestRecreate(agentId);
  return !!row && ACTIVE_RECREATE_STATUSES.includes(row.status);
}

/** AGENT_IDs with a recreate in an active status. */
export function activeRecreateAgentIds(): Set<string> {
  const db = openDb(true);
  try {
    const placeholders = ACTIVE_RECREATE_STATUSES.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT DISTINCT agent_id FROM agent_recreates WHERE status IN (${placeholders})`).all(...ACTIVE_RECREATE_STATUSES) as { agent_id: string }[];
    return new Set(rows.map((r) => r.agent_id));
  } finally {
    db.close();
  }
}

/**
 * At startup no recreate job can be running: any row still active was cut off by the
 * restart. It becomes `interrupted`, keeping the step it was in.
 */
export function markInterruptedRecreates(): number {
  const db = openDb(false);
  try {
    const placeholders = ACTIVE_RECREATE_STATUSES.map(() => '?').join(', ');
    const now = Date.now();
    const info = db.prepare(
      `UPDATE agent_recreates
         SET error = COALESCE(error, 'Rev4a restarted while this step was running: ' || status),
             status = 'interrupted', updated_at = ?, finished_at = ?
       WHERE status IN (${placeholders})`,
    ).run(now, now, ...ACTIVE_RECREATE_STATUSES);
    return info.changes;
  } finally {
    db.close();
  }
}
