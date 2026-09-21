/**
 * GET /api/agents/[id]/invite-link
 *
 * A Control UI link to send to someone else. It carries the gateway token, so the
 * browser that opens it passes gateway auth and lands in the agent's "waiting for
 * approval" list; nothing opens until an operator approves it.
 *
 * Refused on agents without browser approval, where the same link would open the
 * Control UI directly. The host is the one this request reached Rev4a on, never a
 * parameter.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { buildInviteLink, findAgentContainer, hostnameFromHostHeader, requiresBrowserApproval } from '@/lib/agent-devices';

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: noStore });

const isLoopback = (hostname: string) =>
  hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  const hostname = hostnameFromHostHeader(request.headers.get('host'));
  if (!hostname) return fail(400, 'Could not tell which address Rev4a is being reached on');

  let agent;
  try {
    agent = await findAgentContainer(id);
  } catch (e) {
    return fail(503, `Docker is unreachable: ${(e as Error).message}`);
  }
  if (!agent) return fail(404, `No agent '${id}'`);
  if (!agent.running || !agent.controlPort) return fail(409, 'The agent is not running or publishes no Control UI port');

  const requiresApproval = await requiresBrowserApproval(agent.name);
  if (requiresApproval === null) return fail(502, 'Could not tell whether this agent requires browser approval');
  if (!requiresApproval) return fail(409, 'This agent does not require browser approval: anyone with the link would get in');

  try {
    const url = await buildInviteLink(agent.name, hostname, agent.controlPort);
    return NextResponse.json({ url, loopbackHost: isLoopback(hostname) }, { headers: noStore });
  } catch (e) {
    return fail(502, (e as Error).message);
  }
}
