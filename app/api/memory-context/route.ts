import { NextResponse, type NextRequest } from 'next/server';
import { DockerDownError, isValidAgentContainer, listAgentContainers, type AgentContainerRow } from '@/lib/agent-containers';
import {
  CONTEXT_ARGV,
  CONTEXT_MAX_BUFFER,
  CONTEXT_TIMEOUT_MS,
  ContextCache,
  buildContextView,
  contextError,
  parseContextOutput,
  type ContextView,
} from '@/lib/memory-context';
import { dockerExec } from '@/lib/docker-exec';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

const g = globalThis as typeof globalThis & { __rev4aContextCache?: ContextCache };
const cache = (): ContextCache => (g.__rev4aContextCache ??= new ContextCache());

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** One read of the container; the answer holds sizes and times only, never file contents. */
async function readContext(row: AgentContainerRow, signal: AbortSignal): Promise<ContextView> {
  let output: string;
  try {
    output = await dockerExec(row.container, CONTEXT_ARGV, {
      timeoutMs: CONTEXT_TIMEOUT_MS,
      maxBuffer: CONTEXT_MAX_BUFFER,
      signal,
    });
  } catch (e) {
    console.error(`[memory-context] ${row.container}:`, e instanceof Error ? e.message.slice(0, 500) : e);
    const m = contextError(e, row.label);
    throw Object.assign(new Error(m.error), { status: m.status });
  }
  try {
    return buildContextView(parseContextOutput(output));
  } catch (e) {
    console.error(`[memory-context] ${row.container}: unreadable output:`, e instanceof Error ? e.message : e);
    throw Object.assign(new Error('The agent returned unreadable context data'), { status: 502 });
  }
}

/**
 * GET /api/memory-context           the agent containers (for the selector).
 * GET /api/memory-context?agent=<c> what OpenClaw injects into that agent's prompt, read from its container.
 *                                   `fresh=1` skips the 30 s cache. Read-only.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
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

    if (params.get('fresh') !== '1') {
      const hit = cache().get(row.container);
      if (hit) return NextResponse.json({ agent, ...hit });
    }
    const view = await readContext(row, request.signal);
    cache().set(row.container, view);
    return NextResponse.json({ agent, ...view });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (typeof status === 'number') return fail(status, (e as Error).message);
    console.error('[memory-context]', e instanceof Error ? e.message : e);
    return fail(500, 'Could not read the context');
  }
}
