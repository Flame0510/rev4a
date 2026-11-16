import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { currentAgentPortsListen } from '@/lib/agent-ports-server';
import { publishesWiderThan } from '@/lib/agent-ports';
import { dockerFetch } from '@/lib/docker-socket';
import { parseSetting } from '@/lib/listen-addresses';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Mode = 'all' | 'local' | 'address';

/**
 * How many running agents publish ports on a wider address than the setting asks (they were created
 * or last recreated before it): the setting applies at the next Recreate, Update or Edit. Addresses only. null: Docker unreachable.
 */
async function runningAgentsPublishedDifferently(hostIp: string | null): Promise<number | null> {
  if (!hostIp) return 0;
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: ['AGENT_ID'], status: ['running'] }));
    const list = await dockerFetch<{ Id?: string }[]>('GET', `/containers/json?filters=${filters}`);
    const infos = await Promise.all((Array.isArray(list) ? list : []).filter((c) => c.Id).map((c) =>
      dockerFetch<{ HostConfig?: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> } }>('GET', `/containers/${c.Id}/json`).catch(() => null)));
    return infos.filter((i) => i && publishesWiderThan(i.HostConfig?.PortBindings, hostIp)).length;
  } catch {
    return null;
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
  return NextResponse.json({ panel, agents: { mode: agents.hostIp === null ? 'keep' : agents.mode, differing: await runningAgentsPublishedDifferently(agents.hostIp) } });
}
