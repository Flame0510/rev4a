/**
 * Persisted state of agent restores: the `agent_restores` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-restore.ts so busy checks (lib/agent-busy.ts) can ask which
 * agents are being restored without importing the restore action. The machinery is
 * lib/agent-job-state.ts; this file holds the table's types and names.
 */
import { createJobState } from '@/lib/agent-job-state';

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

const state = createJobState({
  table: 'agent_restores',
  initialStatus: 'restoring',
  activeStatuses: ACTIVE_RESTORE_STATUSES,
  finalStatuses: FINAL,
  insertColumns: ['file'],
  writableColumns: [],
});

type Writable = Partial<Pick<AgentRestoreRow, 'status' | 'error'>>;

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

export function markInterruptedRestores(): number {
  return state.markInterrupted();
}

/** Keep the newest `keepPerAgent` restores of each agent; the rest is history. */
export function pruneRestores(keepPerAgent: number): number {
  return state.prune(keepPerAgent);
}
