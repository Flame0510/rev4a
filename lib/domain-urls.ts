import 'server-only';
import { readFile } from 'node:fs/promises';
import { agentHostPort, domainConfig, readAssignments, readManagedRoutes, type DomainAgent } from './domain.js';
import { dockerRequestJson } from './docker-socket-path.js';

type PublicRoute = { url: string; hostPort: number };
export type AgentPublicRouteLookup = (agent: DomainAgent, containerPort: number) => PublicRoute | null;

export function domainIsConfigured(): boolean {
  return Boolean(process.env.REV4A_DOMAIN?.trim());
}

/** Take one snapshot for callers that need several URLs. The managed file is replaced atomically. */
export async function readAgentPublicRoutes(): Promise<AgentPublicRouteLookup | null> {
  try {
    const config = domainConfig(process.env);
    if (!config) return null;
    const { file, domain } = config;
    const content = await readFile(file, 'utf8');
    const routes = readManagedRoutes(content, domain);
    if (!routes) return null;
    const assignments = readAssignments(content, domain);
    return (agent, containerPort) => {
      if (!Number.isInteger(containerPort) || containerPort < 3000 || containerPort > 3009) return null;
      const assignment = assignments.get(agent.containerName);
      if (!assignment) return null;
      const label = containerPort === 3000 ? assignment.name : `${assignment.name}-${containerPort}`;
      const hostPort = routes.get(label);
      return hostPort && hostPort === agentHostPort(agent, containerPort)
        ? { url: `https://${label}.${domain}`, hostPort } : null;
    };
  } catch {
    return null;
  }
}

export async function agentPublicUrl(container: string, containerPort: number): Promise<string | null> {
  if (!Number.isInteger(containerPort) || containerPort < 3000 || containerPort > 3009) return null;
  const lookup = await readAgentPublicRoutes();
  if (!lookup) return null;
  try {
    const inspect = await dockerRequestJson<{
      Name?: string;
      Config?: { Labels?: Record<string, string> };
      State?: { Running?: boolean; Restarting?: boolean };
      NetworkSettings?: { Ports?: DomainAgent['activeBindings'] };
    }>('GET', `/containers/${encodeURIComponent(container)}/json`, 2_000, AbortSignal.timeout(2_000));
    if (inspect.Name !== `/${container}` || !inspect.Config?.Labels?.AGENT_ID) return null;
    return lookup({
      containerName: container,
      running: inspect.State?.Running === true && inspect.State?.Restarting !== true,
      activeBindings: inspect.NetworkSettings?.Ports,
    }, containerPort)?.url ?? null;
  } catch {
    return null;
  }
}

let syncRequested = false;
export function requestDomainRouteSync(): void {
  if (syncRequested) return;
  syncRequested = true;
  void import('./domain-sync').then(({ syncDomainRoutes }) => syncDomainRoutes())
    .catch(() => console.warn('[domain] Could not request Caddy sync.'))
    .finally(() => { syncRequested = false; });
}
