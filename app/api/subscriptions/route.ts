/**
 * GET /api/subscriptions
 *
 * The list the Subscriptions page renders at once: `{ providers: [{ id, name, agents: [{ agentId,
 * name, container, running }] }] }` from docker ps and inspect only, with no exec into any
 * agent (see lib/subscriptions.ts). Each row then asks for its own status:
 *
 * GET /api/subscriptions?agentId=<id>[&provider=<id>]
 *   `{ agent, action }`: that agent's state (connected, account email, plan, expiry, the model
 *   it uses), read live with one exec inside the container, and `action`, its running or last
 *   disconnect job for that provider (or null). The agent panel's Subscription line uses this too.
 *
 * `provider` is resolved by `providerFromParam` in lib/subscription-providers.ts. Missing or
 * empty means the default provider (ChatGPT), so every existing caller gets today's answer; an
 * unknown value is a 400; `anthropic` is Claude, read by lib/subscription-claude.ts and carrying
 * its own `claude` field on the agent. The list form announces ChatGPT, then Claude.
 *
 * Every answer carries `Cache-Control: no-store`: a status can change between two reads.
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getAgentStatus, getProviderList, SubscriptionError } from '@/lib/subscriptions';
import { providerFromParam } from '@/lib/subscription-providers';
import { readClaudeAgent } from '@/lib/subscription-claude';
import { getAction } from '@/lib/subscription-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const params = new URL(request.url).searchParams;
    const provider = providerFromParam(params.get('provider'));
    if (!provider) return json({ error: 'Unknown subscription provider' }, 400);
    const one = params.get('agentId');
    if (one) {
      if (provider.id === 'anthropic') {
        const agent = await readClaudeAgent(one);
        return json({ agent, action: getAction(agent.agentId, 'claude-logout') });
      }
      const agent = await getAgentStatus(one);
      return json({ agent, action: getAction(agent.agentId, 'logout') });
    }
    return json({ providers: await getProviderList() });
  } catch (e) {
    if (e instanceof SubscriptionError) return json({ error: e.message }, e.status);
    return json({ error: 'Could not read the subscriptions' }, 500);
  }
}
