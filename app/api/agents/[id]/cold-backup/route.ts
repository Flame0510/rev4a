/**
 * Cold backup of one agent's volume (lib/cold-backup.ts).
 *
 *   POST    start: the agent is stopped, archived, verified and started again if it
 *           was running. 202 `{ started: true, file }`; the work continues in a helper container.
 *   GET     `{ backup }`: the running or last job, with progress; null when none.
 *   DELETE  cancel the running job: the partial archive is removed and the agent
 *           restarted if it was running.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { isValidAgentId } from '@/lib/container';
import { ColdBackupBusyError, cancelColdBackup, coldBackupStatus, startColdBackup } from '@/lib/cold-backup';
import { agentBusyReason } from '@/lib/agent-busy';

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
  // One source for every long operation: an update, recreate, restore, edit or backup.
  const busy = await agentBusyReason(id);
  if (busy) return NextResponse.json({ error: busy }, { status: 409 });
  try {
    const { file } = await startColdBackup(id, { kind: 'manual' });
    return NextResponse.json({ started: true, file }, { status: 202 });
  } catch (e) {
    const status = e instanceof ColdBackupBusyError ? 409 : /No container|No persistent volume/.test((e as Error).message) ? 404 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

export async function GET(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const id = await agentId(ctx);
  if (id instanceof NextResponse) return id;
  return NextResponse.json({ backup: await coldBackupStatus(id) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const id = await agentId(ctx);
  if (id instanceof NextResponse) return id;
  const cancelled = await cancelColdBackup(id);
  return cancelled
    ? NextResponse.json({ cancelled: true })
    : NextResponse.json({ error: 'No backup of this agent is running' }, { status: 409 });
}
