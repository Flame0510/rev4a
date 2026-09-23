/**
 * Persisted state of agent edits: the `agent_edits` table (lib/db-bootstrap.mjs).
 *
 * Kept apart from lib/agent-edit.ts so busy checks (lib/agent-busy.ts) can ask which
 * agents are being edited without importing the edit action. The machinery is
 * lib/agent-job-state.ts; this file holds the table's types and names.
 */
import { createJobState } from '@/lib/agent-job-state';

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

const state = createJobState({
  table: 'agent_edits',
  initialStatus: 'rebuilding',
  activeStatuses: ACTIVE_EDIT_STATUSES,
  finalStatuses: FINAL,
  insertColumns: ['display_name', 'port_range'],
  writableColumns: [],
});

type Writable = Partial<Pick<AgentEditRow, 'status' | 'error'>>;

export function insertEdit(agentId: string, displayName: string | null, portRange: string | null): number {
  return state.insert(agentId, displayName, portRange);
}

export function updateEditRow(id: number, fields: Writable): void {
  state.update(id, fields);
}

export function latestEdit(agentId: string): AgentEditRow | null {
  return state.latest<AgentEditRow>(agentId);
}

export function isEditActive(agentId: string): boolean {
  return state.isActive(agentId);
}

export function activeEditAgentIds(): Set<string> {
  return state.activeAgentIds();
}

export function markInterruptedEdits(): number {
  return state.markInterrupted();
}

/** Keep the newest `keepPerAgent` edits of each agent; the rest is history. */
export function pruneEdits(keepPerAgent: number): number {
  return state.prune(keepPerAgent);
}
