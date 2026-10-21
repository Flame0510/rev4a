import { NextResponse, type NextRequest } from 'next/server';
import { openDb } from '@/lib/db';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getSession } from '@/lib/agent-sessions-db';
import { openCostsDb } from '@/lib/costs-db';

export const dynamic = 'force-dynamic';

// GET /api/sessions/<session_key>[?container=] -> { session, children, events }.
// The key alone must be unique across containers: 400 when it is not.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;
  const key = decodeURIComponent(id);
  const container = new URL(request.url).searchParams.get('container');
  try {
    const db = openDb();
    let costsDb: ReturnType<typeof openCostsDb> = null;
    try { costsDb = openCostsDb(); } catch { costsDb = null; }
    try {
      const r = getSession(db, { costsDb, container, key });
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
