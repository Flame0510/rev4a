import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { resolveAgentedContainer, isValidAgentId, isLifecycleCoolingDown, markLifecycleCooldown } from '@/lib/container';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { agentBusyReason } from '@/lib/agent-busy';

export const dynamic = 'force-dynamic';

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

/**
 * POST /api/agents/[id]/lifecycle
 * Start, stop, or restart a container by AGENT_ID.
 * Body: { action: "start" | "stop" | "restart" }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;

  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent ID required' }, { status: 400 });
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
    const busy = await agentBusyReason(id);
    if (busy) return NextResponse.json({ error: busy }, { status: 409 });

    const containerName = resolveAgentedContainer(id);
    if (!containerName) {
      return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });
    }

    // Parse and validate action
    let body: { action?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const action = body.action;
    if (!action || typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
      return NextResponse.json({ error: 'action must be one of: start, stop, restart' }, { status: 400 });
    }

    // Rate-limit: reject if a lifecycle op was performed < 3s ago
    if (isLifecycleCoolingDown(id)) {
      return NextResponse.json({ error: 'Rate limited — wait a few seconds', status: 'cooling_down' }, { status: 429 });
    }
    markLifecycleCooldown(id);

    // Check current state to avoid unnecessary operations
    let currentState = 'unknown';
    try {
      currentState = execSync(
        `docker inspect -f '{{.State.Status}}' ${containerName}`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
    } catch {
      return NextResponse.json({ error: `Container ${containerName} not found` }, { status: 404 });
    }

    // No-op for redundant actions
    if (action === 'start' && currentState === 'running') {
      return NextResponse.json({ status: 'running', containerName, message: 'Already running' });
    }
    if (action === 'stop' && currentState !== 'running') {
      return NextResponse.json({ status: 'stopped', containerName, message: 'Already stopped' });
    }

    // Execute
    if (action === 'stop') {
      // Gentle stop first, then force-kill if needed
      try {
        execSync(`docker stop -t 30 ${containerName}`, { timeout: 35000 });
      } catch {
        execSync(`docker kill ${containerName}`, { timeout: 10000 });
      }
    } else {
      execSync(`docker ${action} ${containerName}`, { timeout: 30000 });
    }

    // Read final state
    const newState = execSync(
      `docker inspect -f '{{.State.Status}}' ${containerName}`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();

    return NextResponse.json({ status: newState, containerName });

  } catch (e: unknown) {
    const msg = (e as Error).message || String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
