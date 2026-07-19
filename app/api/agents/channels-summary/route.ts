import { NextResponse, type NextRequest } from 'next/server';
import { getChannels } from '@/lib/channelManager';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';
export const maxDuration = 15; // 15-second timeout for channels summary

/**
 * GET /api/agents/channels-summary
 *
 * Returns a lightweight channel status map for all running agents.
 * { [agentId]: { telegram: boolean, whatsapp: boolean } }
 */
export async function GET(
  _request: NextRequest,
): Promise<NextResponse> {
  try {
    // Discover agents with AGENT_ID label
    const out = execSync(
      `docker ps --filter "label=AGENT_ID" --format '{{.Label "AGENT_ID"}}' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();

    const agentIds = out ? out.split('\n').filter(Boolean) : [];
    const summary: Record<string, { telegram: boolean; whatsapp: boolean }> = {};

    for (const agentId of agentIds) {
      const channels = getChannels(agentId);
      summary[agentId] = {
        telegram: channels.telegram?.connected === true,
        whatsapp: channels.whatsapp?.linked === true || channels.whatsapp !== null,
      };
    }

    return NextResponse.json(summary);
  } catch {
    return NextResponse.json({});
  }
}
