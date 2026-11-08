/**
 * Server-side host-port lookup for lib/agent-ports.ts. Split out because it uses the
 * Docker socket, which client components cannot reach.
 *
 * This is the only place that answers "which host ports are taken": agent creation,
 * the create form, the edit (rename/ports) flow and every container rebuild (update,
 * recreate, rollback) all read their numbers from here.
 *
 * The numbers come from each container's `HostConfig.PortBindings`, the only source
 * that also covers containers that are not running. Neither
 * `docker ps -a --format '{{.Ports}}'` nor the API's container list reports ports for
 * a stopped container (verified on Docker 29: both return nothing), while the
 * allocation is still held — starting that container again fails with "port is
 * already allocated". Reading the bindings is what stops a new agent from being given
 * the block of a stopped one.
 */
import { dockerFetch } from '@/lib/docker-socket';

export interface HostPortHolder {
  /** Container name; agent containers are named after their id. */
  name: string;
  /** The container's `AGENT_NAME`, the name the panel shows; null for non-agent containers. */
  displayName: string | null;
}

interface ContainerInspect {
  Id?: string;
  Name?: string;
  Config?: { Env?: string[] };
  HostConfig?: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
}

/**
 * Host ports held by containers, running or stopped, each mapped to the container that
 * holds it. `excludeContainerId` drops one container from the result: the block of the
 * container a rebuild is about to replace is not a conflict with itself.
 *
 * Best-effort: an unreachable daemon yields an empty map, as the previous shell-based
 * lookup did, rather than failing the caller.
 */
export async function getHostPortHolders(opts: { excludeContainerId?: string } = {}): Promise<Map<number, HostPortHolder>> {
  const holders = new Map<number, HostPortHolder>();
  let list: { Id?: string }[];
  try {
    list = await dockerFetch<{ Id?: string }[]>('GET', '/containers/json?all=true');
  } catch {
    return holders;
  }
  const ids = (Array.isArray(list) ? list : [])
    .map((c) => c.Id)
    .filter((id): id is string => typeof id === 'string' && id !== opts.excludeContainerId);
  const infos = await Promise.all(
    ids.map((id) => dockerFetch<ContainerInspect>('GET', `/containers/${id}/json`).catch(() => null)),
  );
  for (const info of infos) {
    if (!info) continue;
    const name = (info.Name ?? '').replace(/^\//, '') || (info.Id ?? '').slice(0, 12);
    const agentName = (info.Config?.Env ?? []).find((entry) => entry.startsWith('AGENT_NAME='));
    const holder: HostPortHolder = { name, displayName: agentName ? agentName.slice('AGENT_NAME='.length) : null };
    for (const bindings of Object.values(info.HostConfig?.PortBindings ?? {})) {
      for (const binding of bindings ?? []) {
        const port = Number(binding?.HostPort);
        if (Number.isInteger(port)) holders.set(port, holder);
      }
    }
  }
  return holders;
}

/** The port set the validators in lib/agent-ports.ts take. */
export async function getUsedHostPorts(opts: { excludeContainerId?: string } = {}): Promise<Set<number>> {
  return new Set((await getHostPortHolders(opts)).keys());
}

/** How a holder reads in an error: `Night Shift (agent_a0000004)` (the display name first), or the container name alone. */
export function describeHolder(holder: HostPortHolder): string {
  return holder.displayName ? `${holder.displayName} (${holder.name})` : holder.name;
}
