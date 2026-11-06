/** Bounded, identity-pinned shutdown for the claimed Edit/Recreate paths only. */
import { runDocker } from '@/lib/agent-images';
import { dockerRequestJson } from '@/lib/docker-socket-path';

// Give normal SIGTERM shutdown a minute to release the Gateway owner lease. Do not
// wait for OpenClaw's extended 325 s drain: shutdown plus removal must fit inside
// the background caller's budget. Worst case here: 5 + 65 + 5 + 15 = 90 seconds.
export const AGENT_STOP_SECONDS = 60;
export const AGENT_STOP_TIMEOUT_MS = 65_000;
const INSPECT_TIMEOUT_MS = 5_000;
const REMOVE_TIMEOUT_MS = 15_000;

interface StopInspect {
  Id?: string;
  Config?: { Labels?: Record<string, string> };
  State?: { Running?: boolean; ExitCode?: number };
}

async function inspectId(id: string): Promise<StopInspect> {
  // The socket timeout limits inactivity; the independent timer also bounds a
  // response that never ends (including a trickle of bytes).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      dockerRequestJson<StopInspect>('GET', `/containers/${encodeURIComponent(id)}/json`, INSPECT_TIMEOUT_MS, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Container inspection timed out');
          controller.abort(error);
          reject(error);
        }, INSPECT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Never resolve a mutable name after shutdown; a missing/mismatched ID is refused. */
export async function removeAgentContainer(agentId: string, containerId: string | undefined, onWarning?: (message: string) => void): Promise<void> {
  if (!containerId) throw new Error('Cannot recreate an agent without its container ID');
  const current = await inspectId(containerId);
  if (current.Id !== containerId || current.Config?.Labels?.AGENT_ID !== agentId) {
    throw new Error('The container ID does not belong to this agent; nothing was stopped or removed');
  }
  const warn = (reason: string) => {
    const message = `${reason}; forcing removal of the original container. The Gateway owner lease may remain active until it expires.`;
    console.warn(`[agent:stop] ${agentId}: ${message}`);
    onWarning?.(message);
  };
  if (current.State?.Running !== false) {
    let stopped = false;
    try {
      await runDocker(['stop', '-t', String(AGENT_STOP_SECONDS), containerId], { timeoutMs: AGENT_STOP_TIMEOUT_MS });
      stopped = true;
    } catch {
      warn(`Graceful stop failed or timed out after allowing ${AGENT_STOP_SECONDS} seconds`);
    }
    if (stopped) {
      // Docker stop exits 0 even when its own deadline caused SIGKILL.
      const after = await inspectId(containerId).catch(() => null);
      if (after?.State?.ExitCode === 137) warn('Docker reported SIGKILL (exit 137) after the graceful stop');
      else if (!after || after.State?.Running !== false) warn('Could not confirm graceful shutdown');
    }
  }
  await runDocker(['rm', '-f', containerId], { timeoutMs: REMOVE_TIMEOUT_MS });
}
