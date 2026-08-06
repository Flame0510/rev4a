import { NextResponse, type NextRequest } from 'next/server';
import { maybeSendAlert } from '@/lib/alerts';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

function smokeAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.REV4A_ALERT_SMOKE === 'true';
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  if (!smokeAllowed()) return NextResponse.json({ error: 'disabled' }, { status: 403 });

  const stale = new URL(request.url).searchParams.get('stale') !== '0';
  const result = await maybeSendAlert({
    key: 'smoke.telegram-alert',
    kind: 'db-freshness',
    title: 'Rev4a alert smoke',
    message: 'Smoke test alert message.',
    resolvedMessage: 'Smoke test resolved.',
    stale,
  });

  return NextResponse.json({ ok: true, stale, result, dryRun: !process.env.REV4A_TELEGRAM_BOT_TOKEN || !process.env.REV4A_TELEGRAM_CHAT_ID });
}
