import { NextResponse } from 'next/server';
import { REV4A_DATA } from '@/lib/rev4a-paths';
import { clearTimezone, isValidTimezone, readTimezone, writeTimezone } from '@/lib/rev4a-settings';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/** GET /api/settings — `{ timezone, source }`: the saved zone, else REV4A_TIMEZONE, else the server's. */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    return NextResponse.json(readTimezone(REV4A_DATA), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * PUT /api/settings — `{ timezone }`, an IANA zone name known to this runtime (400 otherwise);
 * `{ timezone: null }` forgets the saved zone and answers with the default now in effect.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  let body: { timezone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (body && typeof body === 'object' && body.timezone === null) {
    try {
      clearTimezone(REV4A_DATA);
      return NextResponse.json(readTimezone(REV4A_DATA));
    } catch (e: unknown) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }
  if (!body || typeof body !== 'object' || !isValidTimezone(body.timezone)) {
    return NextResponse.json({ error: 'timezone must be an IANA time zone name, for example Europe/Rome' }, { status: 400 });
  }
  try {
    const timezone = writeTimezone(REV4A_DATA, body.timezone);
    return NextResponse.json({ timezone, source: 'saved' });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
