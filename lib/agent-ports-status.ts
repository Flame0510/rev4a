import 'server-only';
import { isIP } from 'node:net';
import { dockerExec } from './docker-exec';
import { domainIsConfigured, readAgentPublicRoutes } from './domain-urls';
import type { PortBindings } from './agent-ports';

export interface AgentPortStatus {
  containerPort: number;
  hostPort: number;
  listening: boolean | null;
  url: string | null;
  auth: 'basic' | null;
}

/** Read the local port from the Linux TCP tables. 0A is TCP_LISTEN. */
export function parseListeningPorts(text: string): Set<number> | null {
  const lines = text.trim().split(/\r?\n/);
  const header = /^\s*sl\s+local_address\s+rem(?:ote)?_address\s+st\b/;
  if (!header.test(lines[0])) return null;
  const ports = new Set<number>();
  for (const line of lines.slice(1)) {
    if (header.test(line)) continue;
    const row = /^\s*\d+:\s+(?:[\da-f]{8}|[\da-f]{32}):([\da-f]{4})\s+\S+\s+([\da-f]{2})(?:\s|$)/i.exec(line);
    if (!row) return null;
    if (row[2].toUpperCase() === '0A') ports.add(Number.parseInt(row[1], 16));
  }
  return ports;
}

async function readListeningPorts(container: string, signal?: AbortSignal): Promise<Set<number> | null> {
  try {
    const text = await dockerExec(container, ['cat', '/proc/net/tcp', '/proc/net/tcp6'], { timeoutMs: 3_000, signal });
    return parseListeningPorts(text);
  } catch {
    return null;
  }
}

function reachable(hostIp: string | undefined, hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const bind = (hostIp ?? '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!bind || bind === host) return true;
  if (bind === '0.0.0.0') return isIP(host) !== 6;
  if (bind === '::') return isIP(host) !== 4;
  return /^localhost\.?$/.test(host) && (bind === '127.0.0.1' || bind === '::1');
}

/** One row per published TCP container port, preferring the binding the link uses. */
export async function agentPortsStatus(
  container: string,
  running: boolean,
  bindings: PortBindings,
  hostname: string | null,
  signal?: AbortSignal,
  activeBindings: PortBindings = bindings,
): Promise<AgentPortStatus[]> {
  const [publicRoutes, listening] = await Promise.all([
    readAgentPublicRoutes(),
    running ? readListeningPorts(container, signal) : null,
  ]);
  const directLinks = !domainIsConfigured() && running && hostname;
  const agent = { containerName: container, running, activeBindings: activeBindings ?? undefined };
  const rows: AgentPortStatus[] = [];
  for (let containerPort = 3000; containerPort <= 3009; containerPort++) {
    const published = (bindings?.[`${containerPort}/tcp`] ?? []).flatMap((binding) => {
      const hostPort = Number(binding?.HostPort);
      return Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535
        ? [{ hostPort, hostIp: binding.HostIp }] : [];
    });
    if (!published.length) continue;

    const route = publicRoutes?.(agent, containerPort);
    const directBinding = directLinks
      ? published.find(({ hostIp }) => reachable(hostIp, hostname)) : null;
    const hostPort = route?.hostPort ?? (directBinding || published[0]).hostPort;
    rows.push({
      containerPort,
      hostPort,
      listening: listening?.has(containerPort) ?? null,
      url: route?.url ?? (directBinding ? `http://${hostname}:${hostPort}` : null),
      auth: route && containerPort !== 3000 ? 'basic' : null,
    });
  }
  return rows;
}
