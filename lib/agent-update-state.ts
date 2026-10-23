/**
 * Persisted state of agent updates: the `agent_upgrades` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-update.ts so the provider sync can ask which agents are
 * being updated without importing the update action, which imports the sync. The
 * machinery is lib/agent-job-state.ts; this file holds the table's types and names.
 */
import { createJobState } from '@/lib/agent-job-state';
import { openDb } from '@/lib/db';
import { clearStaleSlowStartNote, markResolvedSql } from '@/lib/agent-update-resolution';

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
  /** Set when a failed or interrupted update was later proved fine (lib/agent-update-resolution.ts). */
  resolved_at?: number | null;
  resolution?: string | null;
}

const FINAL: readonly UpdateStatus[] = ['done', 'failed', 'interrupted', 'rolled_back', 'rollback_failed'];

const state = createJobState({
  table: 'agent_upgrades',
  initialStatus: 'pending',
  activeStatuses: ACTIVE_STATUSES,
  finalStatuses: FINAL,
  insertColumns: ['from_version', 'to_version'],
  writableColumns: ['backup_file', 'baseline_json', 'verify_json'],
});

type Writable = Partial<Pick<AgentUpdateRow, 'status' | 'backup_file' | 'baseline_json' | 'verify_json' | 'error'>>;

export function insertUpdate(agentId: string, fromVersion: string | null, toVersion: string): number {
  return state.insert(agentId, fromVersion, toVersion);
}

export function updateRow(id: number, fields: Writable): void {
  state.update(id, fields);
}

export function latestUpdate(agentId: string): AgentUpdateRow | null {
  return state.latest<AgentUpdateRow>(agentId);
}

export function isUpdateActive(agentId: string): boolean {
  return state.isActive(agentId);
}

/** AGENT_IDs with an update in an active status. */
export function activeUpdateAgentIds(): Set<string> {
  return state.activeAgentIds();
}

/**
 * At startup, no update job can be running: any row still active was cut off by the
 * restart. It becomes `interrupted`, keeping the step it was in, so the operator decides
 * between Rollback and a new Update.
 */
export function markInterruptedUpdates(): number {
  const changed = state.markInterrupted();
  if (changed > 0) {
    const db = openDb(false);
    try {
      clearStaleSlowStartNote(db);
    } finally {
      db.close();
    }
  }
  return changed;
}

/** Keep the newest `keepPerAgent` updates of each agent; the rest is history. */
export function pruneUpdates(keepPerAgent: number): number {
  return state.prune(keepPerAgent);
}

/**
 * Store that a failed or interrupted update was proved fine. Only the resolution columns and the
 * verification are written: `status`, `error` and `finished_at` stay as they were, so an older
 * Rev4a reads the row as before. Returns false when the row was already resolved.
 */
export function markUpdateResolved(id: number, resolution: string, verifyJson: string): boolean {
  const db = openDb(false);
  try {
    return markResolvedSql(db, id, resolution, verifyJson, Date.now());
  } finally {
    db.close();
  }
}

/** The newest updates of an agent, newest first (the panel's read-only history). */
export function updateHistory(agentId: string, limit = 20): AgentUpdateRow[] {
  const db = openDb(true);
  try {
    return db.prepare('SELECT * FROM agent_upgrades WHERE agent_id = ? ORDER BY id DESC LIMIT ?').all(agentId, limit) as AgentUpdateRow[];
  } finally {
    db.close();
  }
}

/** The latest update of each agent that is failed or interrupted and not resolved yet. */
export function unresolvedFailedUpdates(): AgentUpdateRow[] {
  const db = openDb(true);
  try {
    return db.prepare(
      `SELECT u.* FROM agent_upgrades u
        WHERE u.id = (SELECT MAX(id) FROM agent_upgrades WHERE agent_id = u.agent_id)
          AND u.status IN ('failed', 'interrupted') AND u.resolved_at IS NULL`,
    ).all() as AgentUpdateRow[];
  } finally {
    db.close();
  }
}
