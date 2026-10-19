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
 */
import { dockerAvailable, dockerFetch } from '@/lib/docker-socket';
import { probeGateway, type GatewayProbe } from '@/lib/agent-readiness';
import { mapWithConcurrency } from '@/lib/docker-exec';
import { gatewayState, type GatewayState } from '@/lib/gateway-state';

const PROBE_TIMEOUT_MS = 3_000;
/** At most this many `docker exec` probes at once: async, but a fleet must not swamp the Docker daemon. */
const PROBE_CONCURRENCY = 4;
const READY_TTL_MS = 60_000;
const NOT_READY_TTL_MS = 2_000;

export interface AgentGatewayStatus {
  state: GatewayState;
  startedAtMs: number | null;
  checkedAtMs: number;
}

const cache = new Map<string, { probe: Exclude<GatewayProbe, 'error'>; at: number }>();
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
  const rows = await mapWithConcurrency(
    Array.isArray(containers) ? containers : [],
    PROBE_CONCURRENCY,
    async (c: any) => {
      const agentId: string = c.Labels?.AGENT_ID || 'unknown';
      const running = c.State === 'running';
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      const checkedAtMs = Date.now();
      if (!running) {
        return { agentId, running, status: { state: 'stopped', startedAtMs: null, checkedAtMs } as AgentGatewayStatus };
      }
      let startedAtMs: number | null = null;
      let probe: GatewayProbe | null = null;
      try {
        const inspect: any = await dockerFetch('GET', `/containers/${c.Id}/json`);
        const startedAt: string = inspect?.State?.StartedAt || '';
        const ms = Date.parse(startedAt);
        startedAtMs = Number.isFinite(ms) && ms > 0 ? ms : null;
        probe = await cachedProbe(c.Id, startedAt, name);
      } catch {
        // This agent only: it shows as unknown and Open stays enabled.
      }
      return {
        agentId,
        running,
        status: { state: gatewayState({ running, startedAtMs, probe, nowMs: Date.now() }), startedAtMs, checkedAtMs: Date.now() } as AgentGatewayStatus,
      };
    },
  );
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
