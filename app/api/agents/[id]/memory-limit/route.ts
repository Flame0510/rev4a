import { NextResponse } from 'next/server';
import { isValidAgentId } from '@/lib/container';
import { agentBusyReason, claimMemoryLimit, releaseMemoryLimit } from '@/lib/agent-busy';
import { EditRefusedError, startAgentEdit } from '@/lib/agent-edit';
import { parseLimitMb } from '@/lib/agent-memory-limit';
import { applyMemoryLimit, readMemoryLimit, type MemoryLimitInfo } from '@/lib/agent-memory-limit-server';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/agents/[id]/memory-limit
 *
 * `{ limitMb, swapMb, running, usageMb, dockerTotalMb }` from the container inspect.
 * `usageMb` is the working-set memory from the Docker stats API (one shot, read when the
 * request arrives); `dockerTotalMb` is `/info` MemTotal. `limitMb` is null when the
 * container has no limit.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;
  if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
  try {
    const info = await readMemoryLimit(id);
    if (!info) return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });
    return NextResponse.json(info, { headers: NO_STORE });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * PUT /api/agents/[id]/memory-limit
 *
 * `{ limitMb: number }` sets the limit live with `docker update` (memory and swap equal,
 * no restart) and answers 200 with the new GET body. `{ limitMb: null }` removes it: Docker
 * cannot do that on a live container, so an edit job rebuilds the container without the
 * flags (the agent restarts, the data volume is kept) and the answer is 202, like PATCH.
 * `409` while another long operation runs on the agent.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;
  if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

  let body: { limitMb?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !('limitMb' in body) || body.limitMb === undefined) {
    return NextResponse.json({ error: 'limitMb is required: a number of MB, or null to remove the limit' }, { status: 400 });
  }
  // Only a literal JSON null removes the limit (it rebuilds the container). 0, '' and "0" are
  // refused: parseLimitMb reads them as "no limit", which is right for a form field but not here.
  let limitMb: number | null;
  if (body.limitMb === null) {
    limitMb = null;
  } else {
    try {
      limitMb = parseLimitMb(body.limitMb);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    if (limitMb === null) {
      return NextResponse.json({ error: 'Memory limit must be at least 256 MB; send null to remove the limit' }, { status: 400 });
    }
  }

  try {
    const current = await readMemoryLimit(id);
    if (!current) return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });

    if (limitMb === null) {
      if (current.limitMb === null) return NextResponse.json(current, { headers: NO_STORE });
      const rowId = await startAgentEdit(id, { removeMemoryLimit: true });
      return NextResponse.json({ started: true, id: rowId }, { status: 202 });
    }

    const busy = await agentBusyReason(id);
    if (busy) return NextResponse.json({ error: busy }, { status: 409 });
    // Held for the whole `docker update`: an edit, recreate, update or restore that starts
    // meanwhile is refused with 409 by agentBusyReason.
    if (!claimMemoryLimit(id)) return NextResponse.json({ error: 'A memory limit change for this agent is being applied' }, { status: 409 });
    try {
      await applyMemoryLimit(id, limitMb);
    } finally {
      releaseMemoryLimit(id);
    }
    // The limit is applied. If the re-read fails or times out, answer with what was applied.
    let updated: MemoryLimitInfo | null = null;
    try {
      updated = await readMemoryLimit(id);
    } catch {
      updated = null;
    }
    return NextResponse.json(
      updated ?? { limitMb, swapMb: limitMb, running: current.running, usageMb: null, dockerTotalMb: null },
      { headers: NO_STORE },
    );
  } catch (e: unknown) {
    if (e instanceof EditRefusedError) {
      return NextResponse.json({ error: e.message }, { status: /Invalid agent id|No fields to update/.test(e.message) ? 400 : 409 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
