/**
 * GET /api/agents/[id]/open-control-ui
 *
 * What the "Open" buttons navigate to, in a new tab. Redirects to the agent's Control
 * UI: through a one-time link that pairs the browser with no approval on OpenClaw 9.x,
 * or through the plain token link when no one-time link can be issued.
 * Optional `job` selects the fixed native Automations destination after validating
 * the job id. It changes no account or job setting and never chooses a redirect host.
 *
 * With `?tunnel=1` the answer is JSON `{ url, port }` (errors `{ error }`) and the link is built for
 * `localhost`, for an SSH tunnel; the dashboard's own host is not used. `?tunnel=port` answers only
 * `{ port }`: the dialog reads the port without issuing a one-time link.
 *
 * The target host comes from the `Host` header, using a different loopback hostname
 * to isolate dashboard cookies, with the agent's published port. It is never a
 * parameter: a page elsewhere that gets a signed-in browser to open this URL can
 * at most open the Control UI in that same browser, never choose an arbitrary host.
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
import { findAgentContainer, hostnameFromHostHeader, resolveControlUiUrl, resolveTunnelControlUiUrl } from '@/lib/agent-devices';
import { isValidCronJobId } from '@/lib/cron-ids';
import { controlUiAutomationUrl, controlUiPortLocalOnly, controlUiTunnelCommand } from '@/lib/control-ui-navigation';

export const dynamic = 'force-dynamic';

/** A plain-text page: this route is opened in a browser tab, not read by code. */
function page(status: number, text: string): NextResponse {
  return new NextResponse(`${text}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** The JSON answer of `?tunnel=1`; the link carries a credential, so nothing may cache it or leak it in a Referer. */
function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const query = new URL(request.url).searchParams;
  // `?tunnel=1` answers JSON for the Open dialog on plain HTTP instead of redirecting.
  const tunnelMode = query.get('tunnel');
  const tunnel = tunnelMode === '1' || tunnelMode === 'port';
  const fail = (status: number, text: string): NextResponse => tunnel ? json({ error: text }, status) : page(status, text);
  const jobs = query.getAll('job');
  if (jobs.length > 1 || jobs.length === 1 && !isValidCronJobId(jobs[0])) return fail(400, 'Invalid automation job id.');
  const jobId = jobs[0];
  const { id } = await params;
  const host = hostnameFromHostHeader(request.headers.get('host'));
  if (!host && !tunnel) return fail(400, 'Could not tell which address Rev4a is being reached on.');

  let agent;
  try {
    agent = await findAgentContainer(id);
  } catch (e) {
    return fail(503, `Docker is unreachable: ${(e as Error).message}`);
  }
  if (!agent) return fail(404, `No agent '${id}'.`);
  if (!agent.running || !agent.controlPort) return fail(409, 'The agent is not running or publishes no Control UI port.');
  if (tunnelMode === 'port') return json({ port: agent.controlPort }, 200);

  // A port published only on the server (REV4A_AGENT_PORTS_LISTEN) cannot be reached from another computer:
  // say so, with the tunnel, instead of redirecting to a dead link. Any caller of this route gets it
  // (the agents, create and automations pages alike). Not knowing the address never blocks.
  if (!tunnel && host) {
    try {
      const inspect: any = await dockerFetch('GET', `/containers/${encodeURIComponent(agent.name)}/json`);
      const hostIp: string | undefined = inspect?.HostConfig?.PortBindings?.['3000/tcp']?.[0]?.HostIp;
      if (controlUiPortLocalOnly(hostIp, host)) {
        return page(409, `This agent's port is open only on the server itself. Use an SSH tunnel: ${controlUiTunnelCommand(agent.controlPort, host, hostIp)} (then open http://localhost:${agent.controlPort}).`);
      }
    } catch {
      // Could not find out: open as before.
    }
  }

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
        return fail(503, "The agent's Gateway is still starting. Try again in a moment.");
      }
    }
  } catch {
    // Could not find out: open as before rather than block on it.
  }

  try {
    if (tunnel) {
      // Always built for localhost, never for a host taken from the request.
      const { url } = await resolveTunnelControlUiUrl(agent.name, agent.controlPort);
      return json({ url: controlUiAutomationUrl(url, jobId), port: agent.controlPort }, 200);
    }
    const { url } = await resolveControlUiUrl(agent.name, host as string, agent.controlPort);
    return new NextResponse(null, {
      status: 302,
      headers: { Location: controlUiAutomationUrl(url, jobId), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  } catch (e) {
    return fail(502, `Could not open the Control UI: ${(e as Error).message}.`);
  }
}
