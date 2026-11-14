/**
 * /api/subscriptions/anthropic/login
 *
 * POST   { agentId }       start Anthropic's own sign-in through Claude Code, installing Claude
 *                          Code first when the agent does not have it
 * GET    ?agentId=         the job: state, Anthropic's link, email, plan or error
 * DELETE ?agentId=         cancel it, inside the container too
 *
 * The job lives in memory (lib/subscription-claude.ts). POST returns the running job with 200
 * when the agent already has a login running, and 409 when the agent is busy, stopped, already
 * connected or not on a supported OpenClaw version; 503 when its status cannot be read. Every
 * answer carries `Cache-Control: no-store`: the body holds a link and an email.
 *
 * The code is NOT part of this route: it goes to /code once, is written to the process and is
 * never stored, logged or returned (Anthropic's flow keeps the tokens in the agent).
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { SubscriptionError } from '@/lib/subscriptions';
import { cancelClaudeLogin, getClaudeLogin, startClaudeLogin } from '@/lib/subscription-claude';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function fail(e: unknown): NextResponse {
  if (e instanceof SubscriptionError) return json({ error: e.message }, e.status);
  return json({ error: 'Subscription login failed' }, 500);
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const body = await request.json().catch(() => ({})) as { agentId?: unknown };
    return json({ login: await startClaudeLogin(body.agentId) });
  } catch (e) {
    return fail(e);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  const agentId = new URL(request.url).searchParams.get('agentId');
  if (!agentId) return json({ error: 'agentId is required' }, 400);
  return json({ login: getClaudeLogin(agentId) });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  const agentId = new URL(request.url).searchParams.get('agentId');
  if (!agentId) return json({ error: 'agentId is required' }, 400);
  try {
    return json({ login: await cancelClaudeLogin(agentId) });
  } catch (e) {
    return fail(e);
  }
}
