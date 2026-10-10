/**
 * The memory limit of an agent container as the dashboard reports it: read from the
 * container inspect, with the container's current working-set memory (the Docker stats
 * API, one shot — the figure `docker stats` shows) and Docker's own total memory
 * (`/info` MemTotal: the VM on macOS, the host on Linux).
 *
 * Setting a limit is `docker update`, which applies live. Removing one is not possible
 * that way (0 means "unchanged" to `docker update`): it goes through the edit job,
 * which rebuilds the container without the flags (lib/agent-edit.ts).
 */
import { dockerRequestJson } from '@/lib/docker-socket-path';
import { runDocker } from '@/lib/agent-images';
import { inspectAgentContainer, type AgentContainerInspect } from '@/lib/agent-recreate';
import { bytesToMb, mbToBytes } from '@/lib/agent-memory-limit';
import { workingSetBytes, MB } from '@/lib/docker-stats';

/** A wedged Docker must not hang the route: reads give up after this and degrade to null. */
const DOCKER_TIMEOUT_MS = 5000;

/** Rejects after `ms`; the underlying call (the shared inspect has no timeout of its own) is abandoned. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface MemoryLimitInfo {
  /** The limit in MB; null when there is none. */
  limitMb: number | null;
  /** Memory plus swap in MB; null when none, -1 for unlimited swap. */
  swapMb: number | null;
  running: boolean;
  /** Working-set memory in MB from the Docker stats API; null when stopped or unreadable. */
  usageMb: number | null;
  /** Docker's total memory in MB; null when unreadable. */
  dockerTotalMb: number | null;
}

function toInfo(container: AgentContainerInspect, usageMb: number | null, dockerTotalMb: number | null): MemoryLimitInfo {
  const swap = container.HostConfig?.MemorySwap;
  return {
    limitMb: bytesToMb(container.HostConfig?.Memory),
    swapMb: swap === -1 ? -1 : bytesToMb(swap),
    running: !!container.State?.Running,
    usageMb,
    dockerTotalMb,
  };
}

async function readUsageMb(container: AgentContainerInspect): Promise<number | null> {
  if (!container.State?.Running || !container.Id) return null;
  try {
    const stats = await dockerRequestJson<{ memory_stats?: { usage?: number; stats?: Record<string, number> } }>(
      'GET', `/containers/${container.Id}/stats?stream=false&one-shot=true`, DOCKER_TIMEOUT_MS,
    );
    const bytes = workingSetBytes(stats?.memory_stats);
    return bytes === null ? null : Math.round(bytes / MB);
  } catch {
    return null;
  }
}

async function readDockerTotalMb(): Promise<number | null> {
  try {
    const info = await dockerRequestJson<{ MemTotal?: number }>('GET', '/info', DOCKER_TIMEOUT_MS);
    return typeof info?.MemTotal === 'number' && info.MemTotal > 0 ? Math.round(info.MemTotal / MB) : null;
  } catch {
    return null;
  }
}

/** The agent's limit, usage and Docker's total; null when no container carries the agent id. */
export async function readMemoryLimit(agentId: string): Promise<MemoryLimitInfo | null> {
  const container = await withTimeout(inspectAgentContainer(agentId), DOCKER_TIMEOUT_MS, 'Docker inspect');
  if (!container) return null;
  const [usageMb, dockerTotalMb] = await Promise.all([readUsageMb(container), readDockerTotalMb()]);
  return toInfo(container, usageMb, dockerTotalMb);
}

/**
 * Apply a limit live. Memory and swap are always passed together and equal: with
 * `--memory` alone the swap keeps its old value. `limitMb` is already validated.
 */
export async function applyMemoryLimit(agentId: string, limitMb: number): Promise<void> {
  const container = await withTimeout(inspectAgentContainer(agentId), DOCKER_TIMEOUT_MS, 'Docker inspect');
  if (!container) throw new Error(`No container found with AGENT_ID '${agentId}'`);
  const name = (container.Name ?? '').replace(/^\//, '') || agentId;
  const bytes = String(mbToBytes(limitMb));
  await runDocker(['update', '--memory', bytes, '--memory-swap', bytes, name], { timeoutMs: 30_000 });
}
