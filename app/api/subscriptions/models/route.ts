/**
 * GET /api/subscriptions/models[?provider=<id>&agentId=<id>]
 *
 * `{ models: [{ key, name, contextWindow }], error, pending }`: the models the connected
 * accounts offer. Finding a connected agent uses the fast status read; the model list itself is
 * an OpenClaw CLI call (about 7 s), cached per account for 10 minutes, so the page loads it apart
 * from the agent rows and fills the Models block when it arrives.
 *
 * `provider` is resolved by `providerFromParam` (lib/subscription-providers.ts): missing or empty
 * is ChatGPT, so today's callers get today's answer; an unknown value is a 400; `anthropic`
 * (Claude) is answered by getClaudeModels, which keeps only the models Claude Code can run.
 * With `agentId`, only that agent's account contributes models and pending status.
 */
import { NextResponse } from 'next/server';
import { isValidAgentId } from '@/lib/container';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getAgentSubscriptionModels, getSubscriptionModels, SubscriptionError } from '@/lib/subscriptions';
import { providerFromParam } from '@/lib/subscription-providers';
import { getAgentClaudeModels, getClaudeModels } from '@/lib/subscription-claude';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 90;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const params = new URL(request.url).searchParams;
    const provider = providerFromParam(params.get('provider'));
    if (!provider) return NextResponse.json({ error: 'Unknown subscription provider' }, { status: 400, headers: NO_STORE });
    const agentId = params.get('agentId');
    if (agentId !== null && !isValidAgentId(agentId)) {
      return NextResponse.json({ error: 'Invalid agent id' }, { status: 400, headers: NO_STORE });
    }
    const models = agentId === null
      ? await (provider.id === 'anthropic' ? getClaudeModels() : getSubscriptionModels())
      : await (provider.id === 'anthropic' ? getAgentClaudeModels(agentId) : getAgentSubscriptionModels(agentId));
    return NextResponse.json(models, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE });
    return NextResponse.json({ error: 'Could not read the models' }, { status: 500, headers: NO_STORE });
  }
}
