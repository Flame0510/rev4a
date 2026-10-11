import { NextResponse } from 'next/server';
import { isValidAgentId } from '@/lib/container';
import { readAgentPackages } from '@/lib/agent-packages-server';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/agents/[id]/packages
 *
 * `{ supported, running, status, packages }`: the apt packages the agent has recorded
 * (`/root/.rev4a/packages.txt`) and the outcome of the last restore after a start
 * (`/root/.rev4a/packages-status.json`). `supported` is false for an agent whose image predates
 * the recorder; a stopped agent answers `running: false` and nothing is read.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;
  if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
  try {
    const result = await readAgentPackages(id);
    if (!result) return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
