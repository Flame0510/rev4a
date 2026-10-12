/**
 * The decision behind "may the user change this agent's credentials now?". Pure on purpose
 * (no imports), so a plain-node test runs the real code.
 *
 * Switching a credential on or off writes into the running OpenClaw of that agent, so it is
 * refused while the container is stopped (nothing there can receive or drop the secret) and
 * while a long job (update, recreate, restore, edit, backup, memory limit) owns the agent.
 * Rev4a re-applies an agent's enabled credentials by itself when such a job ends
 * (`reapplyAssignments`); that path does not go through this check.
 */
export interface AgentWriteState {
  /** The container exists (running or stopped). */
  exists: boolean;
  running: boolean;
  /** Reason from `agentBusyReason`, or null when no job owns the agent. */
  busy: string | null;
}

/** The message to refuse with, or null when the change may go ahead. */
export function writeRefusal(state: AgentWriteState): string | null {
  if (!state.exists) return 'This agent no longer exists';
  if (!state.running) return 'Not running — start the agent to change its credentials';
  if (state.busy) return `Busy: ${state.busy} — its credentials are re-applied when it finishes`;
  return null;
}
