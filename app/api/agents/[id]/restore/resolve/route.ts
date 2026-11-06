/** Operator-confirmed cleanup of one unresolved restore's labelled helpers. */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { isValidAgentId } from '@/lib/container';
import { agentRestoreView, resolveAgentRestore, RestoreRefusedError } from '@/lib/agent-restore';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await ctx.params;
  if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
  const body = await request.json().catch(() => null);
  const restoreId = body?.restoreId;
  if (!Number.isSafeInteger(restoreId) || restoreId < 1) return NextResponse.json({ error: 'A positive restoreId is required' }, { status: 400 });
  try {
    await resolveAgentRestore(id, restoreId);
    return NextResponse.json({ resolved: true, restore: agentRestoreView(id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof RestoreRefusedError ? error.message : 'Restore resolution failed; reservation retained' },
      { status: error instanceof RestoreRefusedError ? 409 : 500 });
  }
}
