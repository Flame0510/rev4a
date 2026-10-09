/**
 * GET /api/subscriptions/usage[?email=<account>][&refresh=1]
 *
 * `{ accounts: [{ email, plan, windows: [{ label, usedPercent, resetAt }], updatedAt }], errors: [{ email, message }] }`:
 * the ChatGPT (Codex) usage limits (5 hours and weekly) of each connected account. The quota is
 * the account's, shared by every agent signed in with it and the owner's own Codex use, so it is
 * read once per account from one running connected agent (an OpenClaw CLI call, 11 to 50 s on a slow host)
 * and cached for 3 minutes, a failed read too. `refresh=1` bypasses the cache. One account failing is an entry in
 * `errors`, not a failed response.
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { SubscriptionError } from '@/lib/subscriptions';
import { getSubscriptionUsage } from '@/lib/subscription-usage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 150;

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const params = new URL(request.url).searchParams;
    const email = params.get('email')?.trim() || null;
    if (email && email.length > 200) return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
    return NextResponse.json(await getSubscriptionUsage({ email, refresh: params.get('refresh') === '1' }));
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Could not read the usage' }, { status: 500 });
  }
}
