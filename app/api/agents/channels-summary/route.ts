import { NextResponse, type NextRequest } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseTelegramChannel } from '@/lib/channelManager';
import { dockerExecNoFail, mapWithConcurrency } from '@/lib/docker-exec';
import { requireAuthJWT } from '@/lib/rev4a-auth';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';
export const maxDuration = 15; // 15-second timeout for channels summary

/** Agents read at once — each is one `docker exec … cat`. */
const AGENT_QUERY_CONCURRENCY = 8;

const AGENT_CONFIG_PATH = '/root/.openclaw/openclaw.json';

/**
 * GET /api/agents/channels-summary
 *
 * Returns a lightweight channel status map for all running agents.
 * { [agentId]: { telegram: boolean } }
 *
 * This used to call getChannels(agentId) in a loop, which re-ran
 * `docker ps --filter label=AGENT_ID=<id>` for every agent just to recover the
 * container name — a name this route's own `docker ps` had already returned and
 * then discarded. So it was 1 + 2N synchronous process spawns to read N files.
 * Now the discovery call carries the container name through, and the configs are
 * read concurrently.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    // Keep the container name alongside the label — the follow-up lookups per
    // agent existed only because this call used to throw the name away.
    const { stdout } = await execFileAsync('docker', [
      'ps', '--filter', 'label=AGENT_ID', '--format', '{{.Label "AGENT_ID"}}\t{{.Names}}',
    ], { encoding: 'utf-8', timeout: 5000 });

    const agents = stdout.trim().split('\n')
      .map((line) => {
        const [agentId, containerName] = line.split('\t');
        if (!agentId?.trim() || !containerName?.trim()) return null;
        return { agentId: agentId.trim(), containerName: containerName.trim() };
      })
      .filter(Boolean) as { agentId: string; containerName: string }[];

    const results = await mapWithConcurrency(agents, AGENT_QUERY_CONCURRENCY, async (agent) => {
      const raw = await dockerExecNoFail(
        agent.containerName,
        ['cat', AGENT_CONFIG_PATH],
        { timeoutMs: 8000 },
      );
      if (!raw) return { agentId: agent.agentId, telegram: false };
      try {
        const config = JSON.parse(raw) as Record<string, unknown>;
        return { agentId: agent.agentId, telegram: parseTelegramChannel(config)?.connected === true };
      } catch {
        return { agentId: agent.agentId, telegram: false };
      }
    });

    const summary: Record<string, { telegram: boolean }> = {};
    for (const r of results) summary[r.agentId] = { telegram: r.telegram };

    return NextResponse.json(summary);
  } catch {
    return NextResponse.json({});
  }
}
