/**
 * GET /api/subscriptions/models
 *
 * `{ models: [{ key, name, contextWindow }], error }`: the models the connected ChatGPT
 * accounts offer. Finding a connected agent uses the fast status read; the model list itself
 * is an OpenClaw CLI call (about 7 s), cached per account for 10 minutes, so the page loads
 * it apart from the agent rows and fills the Models block when it arrives.
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getSubscriptionModels, SubscriptionError } from '@/lib/subscriptions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 90;

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    return NextResponse.json(await getSubscriptionModels());
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Could not read the models' }, { status: 500 });
  }
}
