import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { resolveAgentedContainer, isValidAgentId, isLifecycleCoolingDown, markLifecycleCooldown } from '@/lib/container';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { agentBusyReason } from '@/lib/agent-busy';
import { reapplyWhenReady } from '@/lib/credentials/delivery';
import { dockerFetch } from '@/lib/docker-socket';
import { currentAgentPortsListen } from '@/lib/agent-ports-server';
import { agentPortContainerState, publishesDifferently, type PortBindings } from '@/lib/agent-ports';
import { startAgentRecreate, recreateErrorStatus } from '@/lib/agent-recreate';
import { AgentOperationBusyError, runAgentOperation } from '@/lib/agent-operation';

export const dynamic = 'force-dynamic';

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

/**
 * POST /api/agents/[id]/lifecycle
 * Start, stop, or restart a container by AGENT_ID.
 * Body: { action: "start" | "stop" | "restart", ports?: "as_is" | "move" }
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
    let body: { action?: string; ports?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const action = body?.action;
    if (!action || typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
      return NextResponse.json({ error: 'action must be one of: start, stop, restart' }, { status: 400 });
    }
    if (body.ports !== undefined && body.ports !== 'as_is' && body.ports !== 'move') {
      return NextResponse.json({ error: 'ports must be one of: as_is, move' }, { status: 400 });
    }

    // Rate-limit: reject if a lifecycle op was performed < 3s ago
    if (isLifecycleCoolingDown(id)) {
      return NextResponse.json({ error: 'Rate limited — wait a few seconds', status: 'cooling_down' }, { status: 429 });
    }

    // Check current state to avoid unnecessary operations
    let currentState: ReturnType<typeof agentPortContainerState>;
    let bindings: PortBindings;
    try {
      const inspect = await dockerFetch<{ State?: { Status?: string; Running?: boolean }; HostConfig?: { PortBindings?: PortBindings } }>(
        'GET', `/containers/${encodeURIComponent(containerName)}/json`,
      );
      currentState = agentPortContainerState(inspect.State);
      bindings = inspect.HostConfig?.PortBindings;
    } catch {
      return NextResponse.json({ error: `Container ${containerName} not found` }, { status: 404 });
    }

    const busyAfterInspect = await agentBusyReason(id);
    if (busyAfterInspect) return NextResponse.json({ error: busyAfterInspect }, { status: 409 });

    // No-op for redundant actions
    if (action === 'start' && currentState === 'running') {
      markLifecycleCooldown(id);
      return NextResponse.json({ status: 'running', containerName, message: 'Already running' });
    }
    if (action === 'stop' && currentState === 'stopped') {
      markLifecycleCooldown(id);
      return NextResponse.json({ status: 'stopped', containerName, message: 'Already stopped' });
    }

    if (currentState === 'stopped' && (action === 'start' || action === 'restart')) {
      const setting = currentAgentPortsListen();
      if (publishesDifferently(bindings, setting.hostIp)) {
        if (!body.ports) {
          return NextResponse.json({
            error: "This agent's ports do not match the Remote access setting.",
            code: 'ports_differ', setting: setting.mode,
          }, { status: 409 });
        }
        if (body.ports === 'move') {
          if (isLifecycleCoolingDown(id)) {
            return NextResponse.json({ error: 'Rate limited — wait a few seconds', status: 'cooling_down' }, { status: 429 });
          }
          markLifecycleCooldown(id);
          try {
            const rowId = await startAgentRecreate(id);
            return NextResponse.json({ started: true, id: rowId }, { status: 202 });
          } catch (e) {
            return NextResponse.json({ error: (e as Error).message }, { status: recreateErrorStatus(e) });
          }
        }
      }
    }

    return await runAgentOperation(id, () => {
      // Asking consumes no cooldown. Recheck after the final async busy probe.
      if (isLifecycleCoolingDown(id)) {
        return NextResponse.json({ error: 'Rate limited — wait a few seconds', status: 'cooling_down' }, { status: 429 });
      }
      markLifecycleCooldown(id);

      if (action === 'stop') {
        try {
          execSync(`docker stop -t 30 ${containerName}`, { timeout: 35000 });
        } catch {
          execSync(`docker kill ${containerName}`, { timeout: 10000 });
        }
      } else {
        execSync(`docker ${action} ${containerName}`, { timeout: 30000 });
      }

      if (process.env.REV4A_DOMAIN?.trim()) {
        void import('@/lib/domain-sync').then(({ syncDomainRoutes }) => syncDomainRoutes())
          .catch(() => console.warn('[lifecycle] Could not start the Caddy sync'));
      }

      // A plain start or restart does not go through applyRuntimeConfig, so the agent's
      // credentials are brought in line here, in the background once its Gateway is ready:
      // a secret edited while it was stopped and a removal left pending both land now.
      if (action !== 'stop') {
        void reapplyWhenReady(containerName).catch((e) => console.warn(`[lifecycle] credential re-apply after ${action} failed on ${containerName}:`, (e as Error).message));
      }

      // Read final state
      const newState = execSync(
        `docker inspect -f '{{.State.Status}}' ${containerName}`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();

      return NextResponse.json({ status: newState, containerName });
    });

  } catch (e: unknown) {
    const msg = (e as Error).message || String(e);
    return NextResponse.json({ error: msg }, { status: e instanceof AgentOperationBusyError ? 409 : 500 });
  }
}
