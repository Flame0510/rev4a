/**
 * Persisted state of agent restores: the `agent_restores` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-restore.ts so busy checks (lib/agent-busy.ts) can ask which
 * agents are being restored without importing the restore action. The machinery is
 * lib/agent-job-state.ts; this file holds the table's types and names.
 */
import { createJobState } from '@/lib/agent-job-state';
import { openDb } from '@/lib/db';

export type RestoreStatus = 'restoring' | 'unresolved' | 'done' | 'failed' | 'interrupted';

/** Statuses during which the agent must not be touched by anything else. */
export const ACTIVE_RESTORE_STATUSES: readonly RestoreStatus[] = ['restoring', 'unresolved'];

export interface AgentRestoreRow {
  id: number;
  agent_id: string;
  status: RestoreStatus;
  file: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  /** Additive audit fields; null on jobs written before restore preflight existed. */
  preflight_json: string | null;
  recovery_file: string | null;
  phase: string | null;
  helper_name: string | null;
  source_directory: string | null;
}

const FINAL: readonly RestoreStatus[] = ['done', 'failed', 'interrupted'];

const state = createJobState({
  table: 'agent_restores',
  initialStatus: 'restoring',
  activeStatuses: ACTIVE_RESTORE_STATUSES,
  finalStatuses: FINAL,
  insertColumns: ['file'],
  writableColumns: ['preflight_json', 'recovery_file', 'phase', 'helper_name', 'source_directory'],
});

type Writable = Partial<Pick<AgentRestoreRow, 'status' | 'error' | 'preflight_json' | 'recovery_file' | 'phase' | 'helper_name' | 'source_directory'>>;

export function insertRestore(agentId: string, file: string): number {
  return state.insert(agentId, file);
}

export function updateRestoreRow(id: number, fields: Writable): void {
  state.update(id, fields);
}

export function latestRestore(agentId: string): AgentRestoreRow | null {
  return state.latest<AgentRestoreRow>(agentId);
}

export function isRestoreActive(agentId: string): boolean {
  return state.isActive(agentId);
}

export function activeRestoreAgentIds(): Set<string> {
  return state.activeAgentIds();
}

/** Startup only: record interruption, with no Docker discovery, removal or restart. */
export function markInterruptedRestores(): number {
  const db = openDb(false);
  try {
    return db.transaction(() => {
      const rows = db.prepare("SELECT * FROM agent_restores WHERE status = 'restoring'").all() as AgentRestoreRow[];
      const now = Date.now();
      const update = db.prepare('UPDATE agent_restores SET status = ?, phase = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ?');
      for (const row of rows) {
        const extracting = row.phase === 'extracting';
        const note = extracting
          ? `Rev4a restarted during extraction; cleanup unresolved; helper: ${row.helper_name ?? 'not recorded'}; volume remains reserved. Resolve this restore in Agents > Backups, then review the current volume`
          : `Interrupted during ${row.phase ?? 'an unrecorded legacy phase'}; no automatic extraction or restart was attempted. Review the current volume before retrying`;
        update.run(extracting ? 'unresolved' : 'interrupted', extracting ? 'cleanup_unresolved' : 'interrupted_review',
          `${row.error ? row.error + '; ' : ''}${note}${row.recovery_file ? '; recovery backup: ' + row.recovery_file : ''}`, now, extracting ? null : now, row.id);
      }
      return rows.length;
    }).immediate();
  } finally { db.close(); }
}

/** Keep the newest `keepPerAgent` restores of each agent; the rest is history. */
export function pruneRestores(keepPerAgent: number): number {
  return state.prune(keepPerAgent);
}

/** Automatic backup pruning must retain recovery files referenced by retained restore history. */
export function retainedRestoreRecoveryFiles(agentId: string): string[] {
  const db = openDb(true);
  try {
    return (db.prepare('SELECT recovery_file FROM agent_restores WHERE agent_id = ? AND recovery_file IS NOT NULL').all(agentId) as { recovery_file: string }[])
      .map((row) => row.recovery_file);
  } finally { db.close(); }
}
