/**
 * GET /api/agents/[id]/open-control-ui
 *
 * What the "Open" buttons navigate to, in a new tab. Redirects to the agent's Control
 * UI: through a one-time link that pairs the browser with no approval on OpenClaw 9.x,
 * or through the plain token link when no one-time link can be issued.
 * Optional `job` selects the fixed native Automations destination after validating
 * the job id. It changes no account or job setting and never chooses a redirect host.
 *
 * The target host is the one this request reached Rev4a on (the `Host` header), with
 * the agent's published port. It is never a parameter: a page elsewhere that gets a
 * signed-in browser to open this URL can at most open the Control UI in that same
 * browser, never send the link to another host.
 *
 * While the Gateway answers 503 on `/startupz` (one probe) inside its 10-minute budget from the
 * container's `StartedAt`, the answer is a 503 page, not a redirect to a dead port. Only a real
 * 503 blocks (`blocksOpen`): no answer, a timeout, an unexpected answer, a failure to find out,
 * or a container the restart policy already restarted (`RestartCount > 0`) opens as usual.
 *
 * A navigation rather than a fetch on purpose: the button opens this URL inside the
 * click, so nothing is left to assign to a blank tab after an `await`, and there is
 * no popup for the browser to block. See `lib/agent-devices.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { probeGateway } from '@/lib/agent-readiness';
import { gatewayState, blocksOpen } from '@/lib/gateway-state';
import { dockerFetch } from '@/lib/docker-socket';
import { findAgentContainer, hostnameFromHostHeader, resolveControlUiUrl } from '@/lib/agent-devices';
import { isValidCronJobId } from '@/lib/cron-ids';
import { controlUiAutomationUrl } from '@/lib/control-ui-navigation';

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
  const jobs = new URL(request.url).searchParams.getAll('job');
  if (jobs.length > 1 || jobs.length === 1 && !isValidCronJobId(jobs[0])) return page(400, 'Invalid automation job id.');
  const jobId = jobs[0];
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

  // Only a Gateway that answers 503 inside its 10-minute budget gets the 503 page. Every other
  // outcome, a policy-restarted container and any failure to find out open the Control UI.
  try {
    const inspect: any = await dockerFetch('GET', `/containers/${encodeURIComponent(agent.name)}/json`);
    const startedAtMs = Date.parse(inspect?.State?.StartedAt || '');
    const restartCount = Number(inspect?.RestartCount) || 0;
    if (Number.isFinite(startedAtMs) && startedAtMs > 0 && restartCount === 0) {
      const probe = await probeGateway(agent.name, 3_000);
      const state = gatewayState({ running: true, startedAtMs, probe, nowMs: Date.now() });
      if (blocksOpen(probe, state)) {
        return page(503, "The agent's Gateway is still starting. Try again in a moment.");
      }
    }
  } catch {
    // Could not find out: open as before rather than block on it.
  }

  try {
    const { url } = await resolveControlUiUrl(agent.name, host, agent.controlPort);
    return new NextResponse(null, {
      status: 302,
      headers: { Location: controlUiAutomationUrl(url, jobId), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  } catch (e) {
    return page(502, `Could not open the Control UI: ${(e as Error).message}.`);
  }
}
