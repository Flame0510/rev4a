import { execSync } from 'child_process';

/**
 * Validate an agent id/name against the same rules used at creation.
 * Guards against shell injection in routes that interpolate the id into
 * docker commands. Returns true if the id is safe to use.
 */
export function isValidAgentId(id: string): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
}

/**
 * Resolve the container name from an AGENT_ID label.
 * @returns The container name, or null if no container is found.
 */
export function resolveAgentedContainer(agentId: string): string | null {
  try {
    const found = execSync(
      `docker ps -a --filter "label=AGENT_ID=${agentId}" --format '{{.Names}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    return found || null;
  } catch {
    return null;
  }
}
