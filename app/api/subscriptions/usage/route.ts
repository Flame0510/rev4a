/**
 * GET /api/subscriptions/usage[?email=<account>][&refresh=1][&provider=<id>]
 *
 * `{ accounts: [{ email, plan, windows: [{ label, usedPercent, resetAt }], updatedAt }], errors: [{ email, message, code? }] }`:
 * the ChatGPT (Codex) usage limits (5 hours and weekly) of each connected account. The quota is
 * the account's, shared by every agent signed in with it and the owner's own Codex use, so it is
 * read once per account from one running connected agent (an OpenClaw CLI call, 11 to 50 s on a slow host)
 * and cached for 3 minutes, a failed read too. `refresh=1` bypasses the cache. One account failing is an entry in
 * `errors`, not a failed response.
 * Claude errors may add `code: 'terms-required'`: the account must accept terms at claude.ai.
 *
 * The optional `provider` parameter is resolved by `providerFromParam` (lib/subscription-providers.ts):
 * missing or empty is the default provider, so today's callers get today's answer; an unknown
 * value is a 400, and so is a known provider without usage limits.
 */
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { SubscriptionError } from '@/lib/subscriptions';
import { getSubscriptionUsage } from '@/lib/subscription-usage';
import { getClaudeUsage } from '@/lib/subscription-claude-usage';
import { providerFromParam } from '@/lib/subscription-providers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 150;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;
  try {
    const params = new URL(request.url).searchParams;
    const provider = providerFromParam(params.get('provider'));
    if (!provider) return NextResponse.json({ error: 'Unknown subscription provider' }, { status: 400, headers: NO_STORE });
    if (!provider.hasUsage) return NextResponse.json({ error: 'This subscription provider has no usage limits' }, { status: 400, headers: NO_STORE });
    const email = params.get('email')?.trim() || null;
    if (email && email.length > 200) return NextResponse.json({ error: 'Invalid email' }, { status: 400, headers: NO_STORE });
    const opts = { email, refresh: params.get('refresh') === '1' };
    return NextResponse.json(provider.id === 'anthropic' ? await getClaudeUsage(opts) : await getSubscriptionUsage(opts), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE });
    return NextResponse.json({ error: 'Could not read the usage' }, { status: 500, headers: NO_STORE });
  }
}
