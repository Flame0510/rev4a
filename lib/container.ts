import { execSync } from 'child_process';

const AGENT_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Validate an agent id/name against the same rules used at creation.
 * Guards against shell injection in routes that interpolate the id into
 * docker commands. Returns true if the id is safe to use.
 */
export function isValidAgentId(id: string): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64 && AGENT_ID_REGEX.test(id);
}

/**
 * Escape an agent id for use in `docker ps --filter` label values.
 * Only safe characters pass through; returns empty string on unsafe input.
 */
export function safeAgentId(id: string): string {
  return AGENT_ID_REGEX.test(id) ? id : '';
}

/**
 * Resolve the container name from an AGENT_ID label.
 * @returns The container name, or null if no container is found.
 */
export function resolveAgentedContainer(agentId: string): string | null {
  const safe = safeAgentId(agentId);
  if (!safe) return null;
  try {
    const found = execSync(
      `docker ps -a --filter "label=AGENT_ID=${safe}" --format '{{.Names}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    return found || null;
  } catch {
    return null;
  }
}

/**
 * Operations that mutate containers may trigger their own polling.
 * Keep a lightweight in-memory debounce so rapid toggle clicks don't stack.
 */
const lifecycleCooldown = new Map<string, number>();
const LIFECYCLE_COOLDOWN_MS = 3_000;

/**
 * Returns true if the agent is currently in cooldown (lifecycle operation in progress).
 */
export function isLifecycleCoolingDown(agentId: string): boolean {
  const last = lifecycleCooldown.get(agentId);
  return last != null && Date.now() - last < LIFECYCLE_COOLDOWN_MS;
}

/**
 * Mark an agent as having a lifecycle operation in progress.
 */
export function markLifecycleCooldown(agentId: string): void {
  lifecycleCooldown.set(agentId, Date.now());
}
