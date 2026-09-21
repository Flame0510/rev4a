/**
 * Restore one agent's volume from a backup archive (lib/agent-restore.ts).
 *
 *   POST ?file=…  start: the container is stopped, the volume cleared and the archive
 *                 extracted (up to 30 minutes), then the container is started again even
 *                 when the extract failed. 202 once the job has started; the steps
 *                 continue in the background and are recorded in `agent_restores`.
 *   GET           `{ restore }`: the running or last job; null when none.
 *
 * While it runs, anything else that would touch the agent answers 409 (lib/agent-busy.ts).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { isValidAgentId } from '@/lib/container';
import { agentRestoreView, RestoreRefusedError, startAgentRestore } from '@/lib/agent-restore';

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

  const file = new URL(request.url).searchParams.get('file');
  if (!file) return NextResponse.json({ error: 'file query param required' }, { status: 400 });

  try {
    const rowId = await startAgentRestore(id, file);
    return NextResponse.json({ started: true, id: rowId }, { status: 202 });
  } catch (e) {
    const message = (e as Error).message;
    const status = e instanceof RestoreRefusedError
      ? (/Invalid backup file name|Invalid agent id/.test(message) ? 400 : /not found/.test(message) ? 404 : 409)
      : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

export async function GET(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const id = await agentId(ctx);
  if (id instanceof NextResponse) return id;
  return NextResponse.json({ restore: agentRestoreView(id) }, { headers: { 'Cache-Control': 'no-store' } });
}
