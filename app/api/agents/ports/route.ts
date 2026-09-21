import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getUsedHostPorts } from '@/lib/agent-ports-server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/ports
 *
 * The host ports held by any container, running or stopped — the set the port validators
 * in lib/agent-ports.ts take. The create form receives it as a page prop; the Edit panel
 * fetches it when it opens, so both flows validate a range against the same numbers and
 * the same rules, and give the same message.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const ports = await getUsedHostPorts();
  return NextResponse.json({ ports: [...ports].sort((a, b) => a - b) });
}
