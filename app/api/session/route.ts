import { NextResponse, type NextRequest } from 'next/server';
import { openDb } from '@/lib/db';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getSession } from '@/lib/agent-sessions-db';
import { openCostsDb } from '@/lib/costs-db';

export const dynamic = 'force-dynamic';

// GET /api/session?container=&key= -> { session, children, events }.
// The old ?id=<session key> is accepted for one release: 400 when that key exists in several containers.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const p = new URL(request.url).searchParams;
  const key = p.get('key') || p.get('id');
  if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 });
  try {
    const db = openDb();
    let costsDb: ReturnType<typeof openCostsDb> = null;
    try { costsDb = openCostsDb(); } catch { costsDb = null; }
    try {
      const r = getSession(db, { costsDb, container: p.get('container'), key });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ session: r.session, children: r.children, events: r.events });
    } finally {
      try { costsDb?.close(); } catch { /* ignore */ }
      db.close();
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
