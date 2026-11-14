/**
 * POST /api/subscriptions/anthropic/login/code
 *
 * **Body:** `{ "agentId": "atlas", "code": "<the code Claude Code asks for>" }`.
 *
 * Hands the code to the `claude auth login` process that is waiting for it, once. The request
 * body is never logged, the code is not stored in the job and never appears in an answer: a
 * refused code is a 400 with "Invalid code" and nothing else. 409 when no login of the agent is
 * waiting for a code, or when one has already been submitted (start the sign-in again instead).
 *
 * Response `{ login }` with the job in state `verifying`; the GET of ../login then reports
 * `connecting` and finally `connected` (with the account email and plan) or `failed`.
 *
 * Every answer carries `Cache-Control: no-store`.
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { SubscriptionError } from '@/lib/subscriptions';
import { submitClaudeCode } from '@/lib/subscription-claude';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const body = await request.json().catch(() => ({})) as { agentId?: unknown; code?: unknown };
    return json({ login: await submitClaudeCode(body.agentId, body.code) });
  } catch (e) {
    if (e instanceof SubscriptionError) return json({ error: e.message }, e.status);
    return json({ error: 'Could not submit the code' }, 500);
  }
}
