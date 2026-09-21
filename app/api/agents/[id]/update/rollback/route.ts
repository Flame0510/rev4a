/**
 * POST /api/agents/[id]/update/rollback
 *
 * Roll back the agent's latest update (lib/agent-update.ts): its pre-update backup is
 * restored and the container recreated on the version it ran before. Everything the
 * agent did after that backup is lost. 202 with the update; the steps continue in the
 * background, `GET /api/agents/[id]/update` follows them.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { isValidAgentId } from '@/lib/container';
import { UpdateRefusedError, agentUpdateView, startAgentRollback } from '@/lib/agent-update';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
  try {
    await startAgentRollback(id);
    return NextResponse.json({ update: await agentUpdateView(id) }, { status: 202 });
  } catch (e) {
    const status = e instanceof UpdateRefusedError ? 409 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
