/**
 * GET /api/subscriptions/models[?provider=<id>]
 *
 * `{ models: [{ key, name, contextWindow }], error }`: the models the connected ChatGPT
 * accounts offer. Finding a connected agent uses the fast status read; the model list itself
 * is an OpenClaw CLI call (about 7 s), cached per account for 10 minutes, so the page loads
 * it apart from the agent rows and fills the Models block when it arrives.
 *
 * The optional `provider` parameter is resolved by `providerFromParam` (lib/subscription-providers.ts):
 * missing or empty is the default provider, so today's callers get today's answer; an unknown
 * value is a 400.
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getSubscriptionModels, SubscriptionError } from '@/lib/subscriptions';
import { providerFromParam } from '@/lib/subscription-providers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 90;

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    if (!providerFromParam(new URL(request.url).searchParams.get('provider'))) {
      return NextResponse.json({ error: 'Unknown subscription provider' }, { status: 400 });
    }
    return NextResponse.json(await getSubscriptionModels());
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Could not read the models' }, { status: 500 });
  }
}
