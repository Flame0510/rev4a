/**
 * /api/subscriptions/openai/login
 *
 * POST   { agentId }       start the ChatGPT (Codex) device-code login of one agent
 * GET    ?agentId=         the job: state, link, code, expiry, email or error
 * DELETE ?agentId=         cancel it
 *
 * The job lives in memory (lib/subscription-login.ts). POST returns the running job with 200
 * when the agent already has a login running (or one that just connected and is finishing), and
 * 409 when the agent is busy, stopped, already connected or not on a supported OpenClaw
 * version (2026.9.x); 503 when its subscription status cannot be read. Every answer carries
 * `Cache-Control: no-store`: the body holds the device code.
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { SubscriptionError } from '@/lib/subscriptions';
import { cancelLogin, getLogin, startLogin } from '@/lib/subscription-login';

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
    return json({ login: await startLogin(body.agentId) });
  } catch (e) {
    return fail(e);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  const agentId = new URL(request.url).searchParams.get('agentId');
  if (!agentId) return json({ error: 'agentId is required' }, 400);
  return json({ login: getLogin(agentId) });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  const agentId = new URL(request.url).searchParams.get('agentId');
  if (!agentId) return json({ error: 'agentId is required' }, 400);
  try {
    return json({ login: await cancelLogin(agentId) });
  } catch (e) {
    return fail(e);
  }
}
