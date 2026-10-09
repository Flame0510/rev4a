/**
 * /api/subscriptions/openai/login
 *
 * POST   { agentId }       start the ChatGPT (Codex) device-code login of one agent
 * GET    ?agentId=         the job: state, link, code, expiry, email or error
 * DELETE ?agentId=         cancel it
 *
 * The job lives in memory (lib/subscription-login.ts). POST answers 409 when the agent is
 * busy, stopped, already connected or already has a login running.
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { SubscriptionError } from '@/lib/subscriptions';
import { cancelLogin, getLogin, startLogin } from '@/lib/subscription-login';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function fail(e: unknown): NextResponse {
  if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: e.status });
  return NextResponse.json({ error: 'Subscription login failed' }, { status: 500 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const body = await request.json().catch(() => ({})) as { agentId?: unknown };
    return NextResponse.json({ login: await startLogin(body.agentId) });
  } catch (e) {
    return fail(e);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  const agentId = new URL(request.url).searchParams.get('agentId');
  if (!agentId) return NextResponse.json({ error: 'agentId is required' }, { status: 400 });
  return NextResponse.json({ login: getLogin(agentId) });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  const agentId = new URL(request.url).searchParams.get('agentId');
  if (!agentId) return NextResponse.json({ error: 'agentId is required' }, { status: 400 });
  try {
    return NextResponse.json({ login: await cancelLogin(agentId) });
  } catch (e) {
    return fail(e);
  }
}
