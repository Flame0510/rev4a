import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { readAgentGatewayStatus } from '@/lib/gateway-status';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/gateway
 *
 * Whether each agent's Gateway has finished starting: `{ agents: { [agentId]: { state,
 * startedAtMs, blocksOpen, checkedAtMs } } }`. Separate from the list route on purpose: the list
 * answers from Docker alone, this one runs a probe inside each running container.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    return NextResponse.json({ agents: await readAgentGatewayStatus() });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
