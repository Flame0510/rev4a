import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { resolveAgentedContainer, isValidAgentId } from '@/lib/container';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/agents/[id]/restart
 * Restart a container (docker restart) after verifying it has a matching AGENT_ID label.
 */
export async function POST(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

    const containerName = resolveAgentedContainer(id);
    if (!containerName) {
      return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });
    }

    execSync(`docker restart ${containerName}`, { timeout: 30000 });

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

