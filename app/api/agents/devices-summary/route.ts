/**
 * GET /api/agents/devices-summary
 *
 * Browsers waiting for approval, per running agent — the "browser waiting" badge on
 * the agent cards. One agent that cannot be read reports `error: true` and does not
 * blank the others.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { mapWithConcurrency } from '@/lib/docker-exec';
import { listBrowserAccess, listRunningAgentContainers } from '@/lib/agent-devices';

export const dynamic = 'force-dynamic';

const CONCURRENCY = 3;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;

  let containers: { agentId: string; name: string }[];
  try {
    containers = await listRunningAgentContainers();
  } catch (e) {
    return NextResponse.json({ agents: [], error: `Docker is unreachable: ${(e as Error).message}` }, { status: 503 });
  }

  const agents = await mapWithConcurrency(containers, CONCURRENCY, async ({ agentId, name }) => {
    try {
      const access = await listBrowserAccess(name);
      return { agentId, requiresApproval: access.requiresApproval, pending: access.pending.length };
    } catch {
      return { agentId, requiresApproval: null, pending: 0, error: true };
    }
  });
  return NextResponse.json({ agents });
}
