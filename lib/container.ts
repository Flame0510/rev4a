import { execSync } from 'child_process';

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
