/** POST /api/config/restart — restart all Rev4a services after sending the answer. */
import { after, NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { prepareRestart, RestartUnavailable } from '@/lib/rev4a-restart';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  try {
    const restart = prepareRestart();
    const response = NextResponse.json({ status: 'ok', restarting: true, mode: restart.mode });
    after(() => {
      try { restart.run(); } catch (error) { console.error('[config/restart] restart failed:', error); }
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to restart';
    return NextResponse.json({ status: 'error', message, error: message }, { status: error instanceof RestartUnavailable ? 409 : 500 });
  }
}
