import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { currentAgentPortsListen } from '@/lib/agent-ports-server';
import { publishesDifferently } from '@/lib/agent-ports';
import { dockerFetch } from '@/lib/docker-socket';
import { parseSetting } from '@/lib/listen-addresses';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Mode = 'all' | 'local' | 'address';

/** Inspect stopped containers too: Docker's list omits their port bindings. Never return their ids. */
async function agentsPublishedDifferently(hostIp: string | null) {
  const empty = { differing: 0, stoppedDiffering: 0, runningDiffering: [] as { id: string; name: string }[] };
  if (hostIp === null) return empty;
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: ['AGENT_ID'] }));
    const list = await dockerFetch<{ Id?: string }[]>('GET', `/containers/json?all=true&filters=${filters}`);
    const infos = await Promise.all((Array.isArray(list) ? list : []).filter((c) => c.Id).map((c) =>
      dockerFetch<{ Name?: string; State?: { Running?: boolean }; Config?: { Labels?: Record<string, string>; Env?: string[] }; HostConfig?: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> } }>('GET', `/containers/${c.Id}/json`).catch(() => null)));
    for (const info of infos) {
      if (!info) continue; // A recreate/delete can remove a container after the listing.
      if (!publishesDifferently(info.HostConfig?.PortBindings, hostIp)) continue;
      if (info.State?.Running === true) {
        empty.differing++;
        const id = info.Config?.Labels?.AGENT_ID;
        const name = info.Config?.Env?.find((entry) => entry.startsWith('AGENT_NAME='))?.slice(11) || info.Name?.replace(/^\//, '') || id;
        if (id && name) empty.runningDiffering.push({ id, name });
      } else empty.stoppedDiffering++;
    }
    return empty;
  } catch {
    return { differing: null, stoppedDiffering: null, runningDiffering: [] };
  }
}

/**
 * Where Rev4a listens: the panel's effective addresses (set by server.js at start-up from
 * REV4A_LISTEN) and the mode agents' ports are published with (REV4A_AGENT_PORTS_LISTEN, read
 * now). Addresses only: no secrets.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  let panel: { mode: Mode; port: number; addresses: string[] };
  const port = parseInt(process.env.PORT || '3740', 10) || 3740;
  try {
    const state = JSON.parse(process.env.REV4A_LISTEN_STATE || '');
    panel = { mode: state.mode, port, addresses: Array.isArray(state.addresses) ? state.addresses.map(String) : [] };
    if (!['all', 'local', 'address'].includes(panel.mode)) throw new Error('bad mode');
  } catch {
    // Not started by server.js (next dev): the setting alone, no addresses.
    panel = { mode: parseSetting(process.env.REV4A_LISTEN).kind === 'all' ? 'all' : 'local', port, addresses: [] };
  }
  const agents = currentAgentPortsListen();
  const startedAtMs = Number(process.env.REV4A_STARTED_AT) || null;
  return NextResponse.json({ panel, startedAtMs, agents: { mode: agents.hostIp === null ? 'keep' : agents.mode, ...await agentsPublishedDifferently(agents.hostIp) } });
}
