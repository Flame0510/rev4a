import { NextResponse, type NextRequest } from 'next/server';
import { DockerDownError, isValidAgentContainer, listAgentContainers, type AgentContainerRow } from '@/lib/agent-containers';
import {
  PLUGINS_LIST_ARGV,
  PLUGINS_MAX_BUFFER,
  PLUGINS_TIMEOUT_MS,
  PluginsCache,
  parsePluginsList,
  pluginsError,
  type CachedPlugins,
} from '@/lib/agent-plugins';
import { dockerExec } from '@/lib/docker-exec';
import { requireAuthJWT } from '@/lib/rev4a-auth';

/** One CLI run per container at a time: concurrent requests share it. */
interface Flight {
  promise: Promise<CachedPlugins>;
  startedAt: number;
  waiters: number;
  controller: AbortController;
}

const g = globalThis as typeof globalThis & {
  __rev4aPluginsCache?: PluginsCache;
  __rev4aPluginsFlights?: Map<string, Flight>;
};
const cache = (): PluginsCache => (g.__rev4aPluginsCache ??= new PluginsCache());
const flights = (): Map<string, Flight> => (g.__rev4aPluginsFlights ??= new Map());

class RunError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** Start the CLI in the container. Failures become RunError with a short message; the details are logged. */
function startRun(row: AgentContainerRow): Flight {
  const controller = new AbortController();
  const promise = (async (): Promise<CachedPlugins> => {
    let output: string;
    try {
      output = await dockerExec(row.container, PLUGINS_LIST_ARGV, {
        timeoutMs: PLUGINS_TIMEOUT_MS,
        maxBuffer: PLUGINS_MAX_BUFFER,
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw new RunError(499, 'Request cancelled');
      console.error(`[plugins] ${row.container}:`, e instanceof Error ? e.message.slice(0, 500) : e);
      const m = pluginsError(e, row.label);
      throw new RunError(m.status, m.error);
    }
    try {
      const parsed = parsePluginsList(output);
      cache().set(row.container, parsed);
      return parsed;
    } catch (e) {
      console.error(`[plugins] ${row.container}: unreadable list:`, e instanceof Error ? e.message : e);
      throw new RunError(502, 'The agent returned an unreadable plugin list');
    }
  })();
  const flight: Flight = { promise, startedAt: Date.now(), waiters: 0, controller };
  const map = flights();
  map.set(row.container, flight);
  const done = () => { if (map.get(row.container) === flight) map.delete(row.container); };
  promise.then(done, done);
  return flight;
}

/**
 * The plugins of a container. A plain request joins a run in flight; a fresh one (Reload) joins
 * only a run started after the click, otherwise it starts its own. When every waiter has gone
 * (the page switched agent), the run is cancelled so it keeps no slot.
 */
async function pluginsOf(row: AgentContainerRow, fresh: boolean, arrivedAt: number, signal: AbortSignal): Promise<CachedPlugins> {
  if (!fresh) {
    const hit = cache().get(row.container);
    if (hit) return hit;
  }
  let flight = flights().get(row.container);
  // A run whose waiters all left was aborted: it is dying, so joining it would end in an abort error.
  if (!flight || flight.controller.signal.aborted || (fresh && flight.startedAt < arrivedAt)) flight = startRun(row);
  const f = flight;
  f.waiters++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    f.waiters--;
    if (f.waiters <= 0) f.controller.abort();
  };
  signal.addEventListener('abort', release, { once: true });
  try {
    return await f.promise;
  } finally {
    signal.removeEventListener('abort', release);
    released = true;
  }
}

/**
 * GET /api/plugins           the agent containers (for the selector).
 * GET /api/plugins?agent=<c> that agent's plugins, read from its container. Read-only.
 */
export async function GET(request: NextRequest) {
  const arrivedAt = Date.now();
  const denied = await requireAuthJWT(request); if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const agent = params.get('agent');

  try {
    if (agent === null) {
      try {
        return NextResponse.json({ agents: await listAgentContainers(), dockerAvailable: true });
      } catch (e) {
        if (e instanceof DockerDownError) return NextResponse.json({ agents: [], dockerAvailable: false });
        throw e;
      }
    }

    if (!isValidAgentContainer(agent)) return fail(400, 'Invalid agent');
    let agents: AgentContainerRow[];
    try {
      agents = await listAgentContainers();
    } catch (e) {
      if (e instanceof DockerDownError) return fail(503, 'Docker is not available');
      throw e;
    }
    const row = agents.find((a) => a.container === agent);
    if (!row) return fail(400, `Unknown agent: ${agent}`);
    if (!row.running) return fail(502, `Agent ${row.label} is not running`);

    const result = await pluginsOf(row, params.get('fresh') === '1', arrivedAt, request.signal);
    return NextResponse.json({ agent, plugins: result.plugins, truncated: result.truncated });
  } catch (e) {
    if (e instanceof RunError) return fail(e.status === 499 ? 502 : e.status, e.message);
    console.error('[plugins]', e instanceof Error ? e.message : e);
    return fail(500, 'Could not list plugins');
  }
}

// Enabling and disabling plugins comes later: the page is read-only for now.
async function notAvailable(request: NextRequest) {
  const denied = await requireAuthJWT(request); if (denied) return denied;
  return fail(405, 'Not available yet');
}

export const POST = notAvailable;
export const PUT = notAvailable;
