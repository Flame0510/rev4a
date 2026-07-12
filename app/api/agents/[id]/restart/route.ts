import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';

/**
 * POST /api/agents/[id]/restart
 * Restart a container (docker restart) after verifying it has a matching AGENT_ID label.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });

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

/**
 * Resolve the container name from an AGENT_ID label.
 */
function resolveAgentedContainer(agentId: string): string | null {
  try {
    const found = execSync(
      `docker ps -a --filter "label=AGENT_ID=${agentId}" --format '{{.Names}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    return found || null;
  } catch {
    return null;
  }
}
