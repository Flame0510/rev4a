import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { resolveAgentedContainer, isValidAgentId } from '@/lib/container';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { agentBusyReason } from '@/lib/agent-busy';
import { reapplyWhenReady } from '@/lib/credentials/delivery';
import { dockerFetch } from '@/lib/docker-socket';
import { currentAgentPortsListen } from '@/lib/agent-ports-server';
import { publishesDifferently, type PortBindings } from '@/lib/agent-ports';
import { startAgentRecreate, recreateErrorStatus } from '@/lib/agent-recreate';
import { AgentOperationBusyError, runAgentOperation } from '@/lib/agent-operation';

export const dynamic = 'force-dynamic';

/**
 * POST /api/agents/[id]/restart
 * A stopped mismatch requires the same explicit ports choice as lifecycle Start.
 * Running restart retains its existing response and does not read the setting.
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

    // A restart during an update, recreate, restore, edit or backup would cut it in half.
    const busy = await agentBusyReason(id);
    if (busy) return NextResponse.json({ error: busy }, { status: 409 });

    let body: { ports?: unknown } | null;
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (body?.ports !== undefined && body.ports !== 'as_is' && body.ports !== 'move') {
      return NextResponse.json({ error: 'ports must be one of: as_is, move' }, { status: 400 });
    }
    let inspect: { State?: { Status?: string }; HostConfig?: { PortBindings?: PortBindings } };
    try {
      inspect = await dockerFetch('GET', `/containers/${encodeURIComponent(containerName)}/json`);
    } catch {
      return NextResponse.json({ error: `Container ${containerName} not found` }, { status: 404 });
    }
    const busyAfterInspect = await agentBusyReason(id);
    if (busyAfterInspect) return NextResponse.json({ error: busyAfterInspect }, { status: 409 });
    if (inspect.State?.Status !== 'running') {
      const setting = currentAgentPortsListen();
      if (publishesDifferently(inspect.HostConfig?.PortBindings, setting.hostIp)) {
        if (!body?.ports) return NextResponse.json({
          error: "This agent's ports do not match the Remote access setting.",
          code: 'ports_differ', setting: setting.mode,
        }, { status: 409 });
        if (body.ports === 'move') {
          try {
            const rowId = await startAgentRecreate(id);
            return NextResponse.json({ started: true, id: rowId }, { status: 202 });
          } catch (e) {
            return NextResponse.json({ error: (e as Error).message }, { status: recreateErrorStatus(e) });
          }
        }
      }
    }

    await runAgentOperation(id, () => execSync(`docker restart ${containerName}`, { timeout: 30000 }));
    void reapplyWhenReady(containerName).catch((e) => console.warn(`[restart] credential re-apply failed on ${containerName}:`, (e as Error).message));

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof AgentOperationBusyError ? 409 : 500 });
  }
}

