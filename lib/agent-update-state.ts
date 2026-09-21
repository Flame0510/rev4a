/**
 * Persisted state of agent updates: the `agent_upgrades` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-update.ts so the provider sync can ask which agents are
 * being updated without importing the update action, which imports the sync.
 */
import { openDb } from '@/lib/db';

export type UpdateStatus =
  | 'pending'
  | 'backing_up'
  | 'migrating'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'rolling_back'
  | 'rolled_back'
  | 'rollback_failed';

/** Statuses during which the agent must not be touched by anything else. */
export const ACTIVE_STATUSES: readonly UpdateStatus[] = ['pending', 'backing_up', 'migrating', 'verifying', 'rolling_back'];

export interface AgentUpdateRow {
  id: number;
  agent_id: string;
  status: UpdateStatus;
  from_version: string | null;
  to_version: string;
  backup_file: string | null;
  baseline_json: string | null;
  verify_json: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

const FINAL: readonly UpdateStatus[] = ['done', 'failed', 'interrupted', 'rolled_back', 'rollback_failed'];

export function insertUpdate(agentId: string, fromVersion: string | null, toVersion: string): number {
  const db = openDb(false);
  try {
    const now = Date.now();
    const info = db.prepare(
      `INSERT INTO agent_upgrades (agent_id, status, from_version, to_version, started_at, updated_at)
       VALUES (?, 'pending', ?, ?, ?, ?)`,
    ).run(agentId, fromVersion, toVersion, now, now);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

type Writable = Partial<Pick<AgentUpdateRow, 'status' | 'backup_file' | 'baseline_json' | 'verify_json' | 'error'>>;

export function updateRow(id: number, fields: Writable): void {
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
    db.prepare(`UPDATE agent_upgrades SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  } finally {
    db.close();
  }
}

export function latestUpdate(agentId: string): AgentUpdateRow | null {
  const db = openDb(true);
  try {
    return (db.prepare('SELECT * FROM agent_upgrades WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(agentId) as AgentUpdateRow | undefined) ?? null;
  } finally {
    db.close();
  }
}

export function isUpdateActive(agentId: string): boolean {
  const row = latestUpdate(agentId);
  return !!row && ACTIVE_STATUSES.includes(row.status);
}

/** AGENT_IDs with an update in an active status. */
export function activeUpdateAgentIds(): Set<string> {
  const db = openDb(true);
  try {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT DISTINCT agent_id FROM agent_upgrades WHERE status IN (${placeholders})`).all(...ACTIVE_STATUSES) as { agent_id: string }[];
    return new Set(rows.map((r) => r.agent_id));
  } finally {
    db.close();
  }
}

/**
 * At startup, no update job can be running: any row still active was cut off by the
 * restart. It becomes `interrupted`, keeping the step it was in, so the operator decides
 * between Rollback and a new Update.
 */
export function markInterruptedUpdates(): number {
  const db = openDb(false);
  try {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const now = Date.now();
    const info = db.prepare(
      `UPDATE agent_upgrades
         SET error = COALESCE(error, 'Rev4a restarted while this step was running: ' || status),
             status = 'interrupted', updated_at = ?, finished_at = ?
       WHERE status IN (${placeholders})`,
    ).run(now, now, ...ACTIVE_STATUSES);
    return info.changes;
  } finally {
    db.close();
  }
}
