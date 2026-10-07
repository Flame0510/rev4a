/**
 * Recreate one agent's container on the current build of its OpenClaw version (lib/agent-recreate.ts).
 *
 *   POST    start: a cold backup is taken (the agent stops for it), then the container
 *           is rebuilt and the gateway waited for. 202 once the job has started; the
 *           steps continue in the background and are recorded in `agent_recreates`.
 *   GET     `{ recreate }`: the running or last job, with backup progress; null when none.
 *
 * While it runs, anything else that would touch the agent answers 409 (lib/agent-busy.ts).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { isValidAgentId } from '@/lib/container';
import { agentRecreateView, RecreateRefusedError, startAgentRecreate } from '@/lib/agent-recreate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

async function agentId(ctx: Ctx): Promise<string | NextResponse> {
  const { id } = await ctx.params;
  return isValidAgentId(id) ? id : NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
}

export async function POST(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const id = await agentId(ctx);
  if (id instanceof NextResponse) return id;
  try {
    const rowId = await startAgentRecreate(id);
    return NextResponse.json({ started: true, id: rowId }, { status: 202 });
  } catch (e) {
    const status = e instanceof RecreateRefusedError
      ? 409
      : /No container|not available locally|Cannot tell which image/.test((e as Error).message) ? 404 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

export async function GET(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const id = await agentId(ctx);
  if (id instanceof NextResponse) return id;
  return NextResponse.json({ recreate: await agentRecreateView(id) }, { headers: { 'Cache-Control': 'no-store' } });
}
