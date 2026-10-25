/**
 * Gateway readiness of every agent, for `GET /api/agents/gateway`.
 *
 * Reads the AGENT_ID containers like the list route does (list + inspect for
 * `State.StartedAt`), probes the running ones in parallel through `probeGateway`
 * (the one `/startupz` rule) and decides each state with `gatewayState`.
 *
 * **Cache.** Module-level, keyed by container id *and* `StartedAt`, so a restart
 * starts over. A `ready` answer is reused for 60 s, `starting` and `no_answer` for
 * 2 s. Concurrent requests for the same container share one in-flight probe. An
 * `error` result (the exec itself failed) is not cached.
 *
 * **Budget clock.** A restart policy resets Docker's `StartedAt` at every restart, so a
 * crash loop would stay `starting` for ever. One anchor per container id (module level,
 * memory only: after a Rev4a restart a container with RestartCount 0 is anchored at its
 * StartedAt again, a policy-restarted one gets a new budget) comes from `nextStartAnchor` and
 * replaces `StartedAt` in the state; entries of containers no longer listed are dropped on
 * each read. A container Docker lists as `restarting` is not probed (nothing to exec into):
 * it counts as running with `no_answer`, so it shows `starting`, then `not_ready`.
 */
import { dockerAvailable, dockerFetch } from '@/lib/docker-socket';
import { probeGateway, type GatewayProbe } from '@/lib/agent-readiness';
import { mapWithConcurrency } from '@/lib/docker-exec';
import { gatewayState, blocksOpen, nextStartAnchor, type GatewayState, type StartAnchor } from '@/lib/gateway-state';

const PROBE_TIMEOUT_MS = 3_000;
/** At most this many `docker exec` probes at once: async, but a fleet must not swamp the Docker daemon. */
const PROBE_CONCURRENCY = 4;
const READY_TTL_MS = 60_000;
const NOT_READY_TTL_MS = 2_000;

export interface AgentGatewayStatus {
  state: GatewayState;
  /** When the budget clock started (the anchor), not always Docker's latest `StartedAt`. */
  startedAtMs: number | null;
  /** True only when the Gateway answered 503 inside the budget: the one case Open refuses. */
  blocksOpen: boolean;
  checkedAtMs: number;
}

const cache = new Map<string, { probe: Exclude<GatewayProbe, 'error'>; at: number }>();
const anchors = new Map<string, StartAnchor>();
const inflight = new Map<string, Promise<GatewayProbe>>();

function cachedProbe(containerId: string, startedAt: string, name: string): Promise<GatewayProbe> {
  const key = `${containerId}|${startedAt}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < (hit.probe === 'ready' ? READY_TTL_MS : NOT_READY_TTL_MS)) {
    return Promise.resolve(hit.probe);
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = probeGateway(name, PROBE_TIMEOUT_MS)
    .then((result) => {
      if (result === 'error') return result; // never cached
      cache.set(key, { probe: result, at: Date.now() });
      // Drop entries of earlier starts of this container.
      for (const k of cache.keys()) if (k.startsWith(`${containerId}|`) && k !== key) cache.delete(k);
      return result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Gateway state per agent id. `{}` when Docker is unavailable. Never throws on one agent's failure. */
export async function readAgentGatewayStatus(): Promise<Record<string, AgentGatewayStatus>> {
  if (!dockerAvailable()) return {};
  const containers: any[] = await dockerFetch(
    'GET',
    '/containers/json?all=true&filters={"label":["AGENT_ID"]}',
  );
  const list: any[] = Array.isArray(containers) ? containers : [];
  const listedIds = new Set<string>(list.map((c) => c.Id));
  const rows = await mapWithConcurrency(
    list,
    PROBE_CONCURRENCY,
    async (c: any) => {
      const agentId: string = c.Labels?.AGENT_ID || 'unknown';
      const restarting = c.State === 'restarting';
      // A restarting container counts like a running one: its Gateway is not up yet.
      const running = c.State === 'running' || restarting;
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      const checkedAtMs = Date.now();
      if (!running) {
        return { agentId, running, status: { state: 'stopped', startedAtMs: null, blocksOpen: false, checkedAtMs } as AgentGatewayStatus };
      }
      let startedAtMs: number | null = null;
      let probe: GatewayProbe | null = null;
      let restartCount = 0;
      try {
        const inspect: any = await dockerFetch('GET', `/containers/${c.Id}/json`);
        const startedAt: string = inspect?.State?.StartedAt || '';
        const ms = Date.parse(startedAt);
        const dockerStartMs = Number.isFinite(ms) && ms > 0 ? ms : null;
        probe = restarting ? 'no_answer' : await cachedProbe(c.Id, startedAt, name);
        restartCount = Number(inspect?.RestartCount) || 0;
        const anchor = nextStartAnchor(anchors.get(c.Id), { startedAtMs: dockerStartMs, restartCount, ready: probe === 'ready' });
        if (anchor) anchors.set(c.Id, anchor); else anchors.delete(c.Id);
        startedAtMs = anchor ? anchor.anchorMs : dockerStartMs;
      } catch {
        // This agent only: it shows as unknown and Open stays enabled.
      }
      const state = gatewayState({ running, startedAtMs, probe, nowMs: Date.now() });
      // Same rule as the Open route: a policy-restarted container, or one without a readable start
      // time, never blocks Open, so the button and the route agree.
      const blocks = restartCount === 0 && startedAtMs !== null && blocksOpen(probe, state);
      return {
        agentId,
        running,
        status: { state, startedAtMs, blocksOpen: blocks, checkedAtMs: Date.now() } as AgentGatewayStatus,
      };
    },
  );
  for (const id of [...anchors.keys()]) if (!listedIds.has(id)) anchors.delete(id);
  // One entry per agent id; a running container wins over a stopped one, like the list route.
  const out: Record<string, AgentGatewayStatus> = {};
  const runningSeen = new Set<string>();
  for (const r of rows) {
    if (out[r.agentId] && (runningSeen.has(r.agentId) || !r.running)) continue;
    out[r.agentId] = r.status;
    if (r.running) runningSeen.add(r.agentId);
  }
  return out;
}
