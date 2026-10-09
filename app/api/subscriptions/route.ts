/**
 * GET /api/subscriptions
 *
 * The list the Subscriptions page renders at once: `{ providers: [{ id, name, agents: [{ agentId,
 * name, container, running }] }] }` from docker ps and inspect only, with no exec into any
 * agent (see lib/subscriptions.ts). Each row then asks for its own status:
 *
 * GET /api/subscriptions?agentId=<id>
 *   `{ agent, action }`: that agent's state (connected, account email, plan, expiry, the model
 *   it uses), read live in about 0.5 s with one exec inside the container, and `action`, its
 *   running or last disconnect job (or null). The agent panel's Subscription line
 *   uses this too.
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getAgentStatus, getProviderList, SubscriptionError } from '@/lib/subscriptions';
import { getAction } from '@/lib/subscription-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const one = new URL(request.url).searchParams.get('agentId');
    if (one) {
      const agent = await getAgentStatus(one);
      return NextResponse.json({ agent, action: getAction(agent.agentId) });
    }
    return NextResponse.json({ providers: await getProviderList() });
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Could not read the subscriptions' }, { status: 500 });
  }
}
