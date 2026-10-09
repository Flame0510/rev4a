/**
 * /api/subscriptions/openai/logout
 *
 * POST { agentId }   start the disconnect of an agent as a background job and answer 202 with
 *                    `{ job }` at once: stop using the subscription model first (the agent goes
 *                    back to its own model), then sign out of every ChatGPT (OAuth) profile.
 *                    409 when the agent is busy, stopped, or another change is running.
 * GET ?agentId=      `{ job }`: `running` then `done` | `failed` (with `error`); null when there
 *                    is no disconnect job for the agent. A job that failed because the agent
 *                    uses the subscription model with no model of its own says so.
 *
 * The jobs live in memory (lib/subscription-actions.ts).
 */
import { NextResponse } from 'next/server';
import { agentBusyReason } from '@/lib/agent-busy';
import { isLoginFinishingOnly } from '@/lib/subscription-login';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { SubscriptionError, findAgentContainer } from '@/lib/subscriptions';
import { getAction, startAction } from '@/lib/subscription-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const body = await request.json().catch(() => ({})) as { agentId?: unknown };
    const agent = await findAgentContainer(body.agentId);
    if (!agent.running) return NextResponse.json({ error: 'The agent is stopped. Start it first.' }, { status: 409 });
    // The tail of a login that already connected is waited for by the job itself.
    const busy = await agentBusyReason(agent.agentId, { ignoreLogin: isLoginFinishingOnly(agent.agentId) });
    if (busy) return NextResponse.json({ error: busy }, { status: 409 });
    return NextResponse.json({ job: startAction('logout', agent.agentId) }, { status: 202 });
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Disconnect failed' }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  const agentId = new URL(request.url).searchParams.get('agentId');
  if (!agentId) return NextResponse.json({ error: 'agentId is required' }, { status: 400 });
  return NextResponse.json({ job: getAction(agentId, 'logout') });
}
