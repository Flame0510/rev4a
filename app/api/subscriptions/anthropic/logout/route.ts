/**
 * /api/subscriptions/anthropic/logout
 *
 * POST { agentId }   start the disconnect of an agent as a background job and answer 202 with
 *                    `{ job }` at once: stop using the `anthropic/` models (the agent goes back
 *                    to its own model), remove the Claude Code runtime rule, run Claude Code's own
 *                    `auth logout` and read the status back. 409 when the agent is busy, stopped,
 *                    or another subscription change is running.
 * GET ?agentId=      `{ job }`: `running` then `done` | `failed` (with `error`); null when there
 *                    is no disconnect job for the agent. A job that failed because the agent uses
 *                    the subscription model with no model of its own says so.
 *
 * The jobs live in memory (lib/subscription-actions.ts), one per agent across both providers.
 * Every answer carries `Cache-Control: no-store`.
 */
import { NextResponse } from 'next/server';
import { agentBusyReason } from '@/lib/agent-busy';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { SubscriptionError, findAgentContainer } from '@/lib/subscriptions';
import { getAction, startAction } from '@/lib/subscription-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const body = await request.json().catch(() => ({})) as { agentId?: unknown };
    const agent = await findAgentContainer(body.agentId);
    if (!agent.running) return json({ error: 'The agent is stopped. Start it first.' }, 409);
    // A Claude login that is still finishing its sign-in blocks the disconnect: the job itself
    // waits (waitForClaudeLoginExit) only for a job that has already left its active states.
    const busy = await agentBusyReason(agent.agentId);
    if (busy) return json({ error: busy }, 409);
    return json({ job: startAction('claude-logout', agent.agentId) }, 202);
  } catch (e) {
    if (e instanceof SubscriptionError) return json({ error: e.message }, e.status);
    return json({ error: 'Disconnect failed' }, 500);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  const agentId = new URL(request.url).searchParams.get('agentId');
  if (!agentId) return json({ error: 'agentId is required' }, 400);
  return json({ job: getAction(agentId, 'claude-logout') });
}
