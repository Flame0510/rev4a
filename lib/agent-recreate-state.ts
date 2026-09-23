/**
 * Persisted state of agent recreates: the `agent_recreates` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-recreate.ts so busy checks (lib/agent-busy.ts, the provider
 * sync) can ask which agents are being recreated without importing the recreate action.
 * The machinery is lib/agent-job-state.ts; this file holds the table's types and names.
 */
import { createJobState } from '@/lib/agent-job-state';

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

const state = createJobState({
  table: 'agent_recreates',
  initialStatus: 'backing_up',
  activeStatuses: ACTIVE_RECREATE_STATUSES,
  finalStatuses: FINAL,
  insertColumns: ['image'],
  writableColumns: ['backup_file'],
});

type Writable = Partial<Pick<AgentRecreateRow, 'status' | 'backup_file' | 'error'>>;

export function insertRecreate(agentId: string, image: string): number {
  return state.insert(agentId, image);
}

export function updateRecreateRow(id: number, fields: Writable): void {
  state.update(id, fields);
}

export function latestRecreate(agentId: string): AgentRecreateRow | null {
  return state.latest<AgentRecreateRow>(agentId);
}

export function isRecreateActive(agentId: string): boolean {
  return state.isActive(agentId);
}

export function activeRecreateAgentIds(): Set<string> {
  return state.activeAgentIds();
}

export function markInterruptedRecreates(): number {
  return state.markInterrupted();
}

/** Keep the newest `keepPerAgent` recreates of each agent; the rest is history. */
export function pruneRecreates(keepPerAgent: number): number {
  return state.prune(keepPerAgent);
}
