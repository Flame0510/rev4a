import { NextResponse } from 'next/server';
import { parseLimitMb } from '@/lib/agent-memory-limit';
import { readAgentDefaults, writeAgentDefaults } from '@/lib/agent-defaults';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/** GET /api/agent-defaults — `{ memoryLimitMb: number | null }`: the prefill for new agents. */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  return NextResponse.json(readAgentDefaults(), { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * PUT /api/agent-defaults — `{ memoryLimitMb: number | null }` (256 to 1048576 MB; null, 0
 * or an empty string clear it). Only prefills the create wizard; no existing agent changes.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  let body: { memoryLimitMb?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !('memoryLimitMb' in body)) {
    return NextResponse.json({ error: 'memoryLimitMb is required: a number of MB, or null for none' }, { status: 400 });
  }
  let memoryLimitMb: number | null;
  try {
    memoryLimitMb = parseLimitMb(body.memoryLimitMb);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    writeAgentDefaults({ memoryLimitMb });
    return NextResponse.json({ memoryLimitMb });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
