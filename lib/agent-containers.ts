import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAgentDisplayNames } from './agent-names';
import { resolveDockerSocket } from './docker-socket';
import { AGENT_PS_FORMAT, parseAgentPs, parseWorkspaceId } from './workspace-fs';

const execFileAsync = promisify(execFile);
const HOST_DOCKER_TIMEOUT_MS = 5000;

export interface AgentContainerRow {
  container: string;
  label: string;
  running: boolean;
}

export class DockerDownError extends Error {
  constructor() {
    super('Docker is not available');
  }
}

/**
 * Every agent container, running or stopped, with the name the dashboard shows. Same `docker ps`
 * and label fallback as the Workspace page. Throws DockerDownError when Docker cannot answer.
 */
export async function listAgentContainers(): Promise<AgentContainerRow[]> {
  if (!resolveDockerSocket()) throw new DockerDownError();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'docker',
      ['ps', '-a', '--filter', 'label=AGENT_ID', '--format', AGENT_PS_FORMAT],
      { timeout: HOST_DOCKER_TIMEOUT_MS, encoding: 'utf-8' },
    ));
  } catch {
    throw new DockerDownError();
  }
  const rows = parseAgentPs(stdout);
  const names = await getAgentDisplayNames(rows.map((r) => r.name));
  return rows.map((r) => ({
    container: r.name,
    label: names.get(r.name) || `${r.agentId} (${r.name})`,
    running: r.running,
  }));
}

/** True for a container name taken from a request: the Workspace page's rule, not a copy of it. */
export function isValidAgentContainer(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 128 && parseWorkspaceId(`container-${v}`) !== null;
}
