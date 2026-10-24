import { NextResponse, type NextRequest } from 'next/server';
import { openDb } from '@/lib/db';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { DEFAULT_SNOOZE_HOURS, isValidScope, snooze } from '@/lib/spend-alerts';

export const dynamic = 'force-dynamic';

/**
 * POST /api/alerts/snooze { agent, hours? } — snooze the spend alarms of one agent (an agent id or
 * container name; `vendor:<name>` for a vendor's balance alarm) for `hours` (default 24, at most
 * 720). The daemon keeps evaluating a snoozed agent and simply does not alert. Stored in events.db
 * `alert_state`, so it survives a restart. Requires auth. 400 for a bad agent or hours.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as NextResponse;

  const body = (await request.json().catch(() => null)) as { agent?: unknown; hours?: unknown } | null;
  if (!isValidScope(body?.agent)) {
    return NextResponse.json({ error: 'agent must be an agent id, a container name or vendor:<name>' }, { status: 400 });
  }
  let hours = DEFAULT_SNOOZE_HOURS;
  if (body?.hours !== undefined) {
    if (typeof body.hours !== 'number' || !Number.isFinite(body.hours) || body.hours <= 0) {
      return NextResponse.json({ error: 'hours must be a positive number' }, { status: 400 });
    }
    hours = body.hours;
  }
  try {
    const db = openDb(false);
    try {
      const until = snooze(db, body!.agent as string, hours);
      return NextResponse.json({ ok: true, agent: body!.agent, until });
    } finally {
      db.close();
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
