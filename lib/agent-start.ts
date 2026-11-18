/** Client lifecycle response shared by the Agents switch and its explicit port choices. */
export type AgentStartChoice = 'as_is' | 'move';
export type AgentLifecycleResult =
  | { kind: 'ports_differ'; setting: string }
  | { kind: 'recreate'; id: number }
  | { kind: 'complete' };

export async function requestAgentLifecycle(
  agentId: string, action: 'start' | 'stop' | 'restart', signal: AbortSignal, ports?: AgentStartChoice,
): Promise<AgentLifecycleResult> {
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/lifecycle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ action, ...(ports ? { ports } : {}) }),
  });
  const data = await response.json();
  if (response.status === 409 && data.code === 'ports_differ') return { kind: 'ports_differ', setting: data.setting };
  if (!response.ok) throw new Error(data.error || 'Could not change the agent state.');
  if (response.status === 202) {
    if (!Number.isInteger(data.id)) throw new Error('The recreate job id is missing.');
    return { kind: 'recreate', id: data.id };
  }
  return { kind: 'complete' };
}

/** Human-readable current Control UI binding, also used for local → all mismatches. */
export function agentPortsLabel(hostIp?: string | null): string {
  return !hostIp || ['', '0.0.0.0', '::', '[::]'].includes(hostIp) ? 'every interface' : hostIp;
}
