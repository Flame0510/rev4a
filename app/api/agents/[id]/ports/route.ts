import { NextResponse, type NextRequest } from 'next/server';
import { findAgentContainer, hostnameFromHostHeader } from '@/lib/agent-devices';
import { agentPortsStatus } from '@/lib/agent-ports-status';
import type { PortBindings } from '@/lib/agent-ports';
import { dockerRequestJson } from '@/lib/docker-socket-path';
import { canRouteAgent, type DomainAgentState } from '@/lib/domain';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  const deadline = AbortSignal.timeout(5_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  const readDocker = <T,>(method: string, path: string) => dockerRequestJson<T>(method, path, 0, signal);
  try {
    const agent = await findAgentContainer(id, readDocker);
    if (!agent) return NextResponse.json({ error: `No agent '${id}'` }, { status: 404 });
    const inspect = await readDocker<{
      State?: DomainAgentState;
      HostConfig?: { PortBindings?: PortBindings };
      NetworkSettings?: { Ports?: PortBindings };
    }>('GET', `/containers/${encodeURIComponent(agent.name)}/json`);
    const running = canRouteAgent({ ...inspect.State, Running: inspect.State?.Running ?? agent.running });
    const activeBindings = running ? inspect.NetworkSettings?.Ports ?? null : null;
    const bindings = activeBindings ?? inspect.HostConfig?.PortBindings;
    const hostname = hostnameFromHostHeader(request.headers.get('host'));
    const ports = await agentPortsStatus(agent.name, running, bindings, hostname, signal, activeBindings);
    return NextResponse.json({ ports }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (deadline.aborted) return NextResponse.json({ error: 'Reading agent ports timed out' }, { status: 504 });
    return NextResponse.json({ error: `Could not read agent ports: ${(e as Error).message}` }, { status: 503 });
  }
}
