/**
 * GET /api/gateway/provider/balance?provider=deepseek
 *
 * Fetches the current balance/credits from an upstream AI provider.
 * Requires the provider's API key to be configured in provider-keys.json.
 *
 * Supported providers: deepseek, openrouter, glm
 */
import { NextRequest, NextResponse } from 'next/server';
import { fetchProviderBalance, BalanceUnsupportedError, type BalanceProvider } from '@/lib/provider-balance';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUPPORTED: BalanceProvider[] = ['deepseek', 'openrouter', 'glm'];

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const provider = request.nextUrl.searchParams.get('provider') as BalanceProvider | null;

  if (!provider || !SUPPORTED.includes(provider)) {
    return NextResponse.json(
      {
        error: `Unsupported or missing provider. Supported: ${SUPPORTED.join(', ')}`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await fetchProviderBalance(provider);
    return NextResponse.json({ provider, ...result });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    // A permanent "no balance API for this account" is reported distinctly, so
    // the UI can hide the badge instead of offering a retry that never works.
    const reason = e instanceof BalanceUnsupportedError ? 'no-balance-api' : undefined;
    return NextResponse.json({ provider, error: message, ...(reason && { reason }) }, { status: 502 });
  }
}
