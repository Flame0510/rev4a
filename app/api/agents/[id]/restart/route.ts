import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';

/**
 * POST /api/agents/[id]/restart
 * Restart a container (docker restart).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });

    execSync(`docker restart ${id}`, { timeout: 30000 });

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
