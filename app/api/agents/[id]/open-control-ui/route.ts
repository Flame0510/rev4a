/**
 * GET /api/agents/[id]/open-control-ui
 *
 * What the "Open" buttons navigate to, in a new tab. Redirects to the agent's Control
 * UI: through a one-time link that pairs the browser with no approval on OpenClaw 9.x,
 * or through the plain token link on 2026.7.x or when no one-time link can be issued.
 *
 * The target host is the one this request reached Rev4a on (the `Host` header), with
 * the agent's published port. It is never a parameter: a page elsewhere that gets a
 * signed-in browser to open this URL can at most open the Control UI in that same
 * browser, never send the link to another host.
 *
 * A navigation rather than a fetch on purpose: the button opens this URL inside the
 * click, so nothing is left to assign to a blank tab after an `await`, and there is
 * no popup for the browser to block. See `lib/agent-devices.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { findAgentContainer, hostnameFromHostHeader, resolveControlUiUrl } from '@/lib/agent-devices';

export const dynamic = 'force-dynamic';

/** A plain-text page: this route is opened in a browser tab, not read by code. */
function page(status: number, text: string): NextResponse {
  return new NextResponse(`${text}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  const host = hostnameFromHostHeader(request.headers.get('host'));
  if (!host) return page(400, 'Could not tell which address Rev4a is being reached on.');

  let agent;
  try {
    agent = await findAgentContainer(id);
  } catch (e) {
    return page(503, `Docker is unreachable: ${(e as Error).message}`);
  }
  if (!agent) return page(404, `No agent '${id}'.`);
  if (!agent.running || !agent.controlPort) return page(409, 'The agent is not running or publishes no Control UI port.');

  try {
    const { url } = await resolveControlUiUrl(agent.name, host, agent.controlPort);
    return new NextResponse(null, {
      status: 302,
      headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  } catch (e) {
    return page(502, `Could not open the Control UI: ${(e as Error).message}.`);
  }
}
