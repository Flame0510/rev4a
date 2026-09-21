/**
 * Persisted state of agent edits: the `agent_edits` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-edit.ts so busy checks (lib/agent-busy.ts) can ask which
 * agents are being edited without importing the edit action.
 */
import { openDb } from '@/lib/db';

export type EditStatus = 'rebuilding' | 'done' | 'failed' | 'interrupted';

/** Statuses during which the agent must not be touched by anything else. */
export const ACTIVE_EDIT_STATUSES: readonly EditStatus[] = ['rebuilding'];

export interface AgentEditRow {
  id: number;
  agent_id: string;
  status: EditStatus;
  display_name: string | null;
  port_range: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

const FINAL: readonly EditStatus[] = ['done', 'failed', 'interrupted'];

export function insertEdit(agentId: string, displayName: string | null, portRange: string | null): number {
  const db = openDb(false);
  try {
    const now = Date.now();
    const info = db.prepare(
      `INSERT INTO agent_edits (agent_id, status, display_name, port_range, started_at, updated_at)
       VALUES (?, 'rebuilding', ?, ?, ?, ?)`,
    ).run(agentId, displayName, portRange, now, now);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

type Writable = Partial<Pick<AgentEditRow, 'status' | 'error'>>;

export function updateEditRow(id: number, fields: Writable): void {
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
    db.prepare(`UPDATE agent_edits SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  } finally {
    db.close();
  }
}

export function latestEdit(agentId: string): AgentEditRow | null {
  const db = openDb(true);
  try {
    return (db.prepare('SELECT * FROM agent_edits WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(agentId) as AgentEditRow | undefined) ?? null;
  } finally {
    db.close();
  }
}

export function isEditActive(agentId: string): boolean {
  const row = latestEdit(agentId);
  return !!row && ACTIVE_EDIT_STATUSES.includes(row.status);
}

/** AGENT_IDs with an edit in an active status. */
export function activeEditAgentIds(): Set<string> {
  const db = openDb(true);
  try {
    const placeholders = ACTIVE_EDIT_STATUSES.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT DISTINCT agent_id FROM agent_edits WHERE status IN (${placeholders})`).all(...ACTIVE_EDIT_STATUSES) as { agent_id: string }[];
    return new Set(rows.map((r) => r.agent_id));
  } finally {
    db.close();
  }
}

/**
 * At startup no edit job can be running: a row still active was cut off by the restart.
 * It becomes `interrupted`, keeping the name and port it was applying.
 */
export function markInterruptedEdits(): number {
  const db = openDb(false);
  try {
    const placeholders = ACTIVE_EDIT_STATUSES.map(() => '?').join(', ');
    const now = Date.now();
    const info = db.prepare(
      `UPDATE agent_edits
         SET error = COALESCE(error, 'Rev4a restarted while this step was running: ' || status),
             status = 'interrupted', updated_at = ?, finished_at = ?
       WHERE status IN (${placeholders})`,
    ).run(now, now, ...ACTIVE_EDIT_STATUSES);
    return info.changes;
  } finally {
    db.close();
  }
}
