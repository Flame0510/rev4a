import { NextResponse, type NextRequest } from 'next/server';
import { listAllAssignments } from '@/lib/credentials/assignments';
import { listProfiles } from '@/lib/credentials/vault';
import { listAgentContainers } from '@/lib/subscriptions';
import { agentBusyReason } from '@/lib/agent-busy';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/credentials/assignments?agent=<container>
 * Every assignment (enabled, switched off, removal pending or failed), with the credential's label and provider. Also lists the
 * agents (container, displayName, running, busy). Reads the
 * vault database only (no exec into any agent), so the agent panel can call it freely.
 * No secret, not even a masked one, is returned.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const agent = new URL(request.url).searchParams.get('agent');
    const profiles = new Map(listProfiles().map((p) => [p.id, p]));
    const items = listAllAssignments()
      .filter((a) => (agent ? a.agentId === agent : true))
      .filter((a) => profiles.has(a.profileId))
      .map((a) => ({
        ...a,
        label: profiles.get(a.profileId)!.label,
        providerId: profiles.get(a.profileId)!.providerId,
      }));
    // Containers that exist (running or stopped), so the page can tell a stopped agent from a missing one.
    // `agents` adds the display name, the running flag and the job (if any) that owns the agent.
    let knownAgents: string[] = [];
    let agents: { container: string; displayName: string | null; running: boolean; busy: string | null }[] = [];
    try {
      const rows = await listAgentContainers();
      knownAgents = rows.map((a) => a.container);
      agents = await Promise.all(rows.map(async (a) => ({
        container: a.container,
        displayName: a.displayName,
        running: a.running,
        busy: await agentBusyReason(a.agentId).catch(() => null),
      })));
    } catch { /* docker unavailable: the page treats every row as unknown */ }
    return NextResponse.json({ assignments: items, knownAgents, agents });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
