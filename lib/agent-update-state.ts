/**
 * Persisted state of agent updates: the `agent_upgrades` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-update.ts so the provider sync can ask which agents are
 * being updated without importing the update action, which imports the sync. The
 * machinery is lib/agent-job-state.ts; this file holds the table's types and names.
 */
import { createJobState } from '@/lib/agent-job-state';

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
  return state.markInterrupted();
}

/** Keep the newest `keepPerAgent` updates of each agent; the rest is history. */
export function pruneUpdates(keepPerAgent: number): number {
  return state.prune(keepPerAgent);
}
