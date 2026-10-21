import { NextResponse, type NextRequest } from 'next/server';
import { openDb } from '@/lib/db';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { listSessions } from '@/lib/agent-sessions-db';
import { openCostsDb } from '@/lib/costs-db';

export const dynamic = 'force-dynamic';

// GET /api/sessions?container=&since=<ms>&kind=&active=1&limit=
// -> { sessions, total, version }. Reads agent_sessions (see lib/agent-sessions-db.ts).
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const p = new URL(request.url).searchParams;
  const numParam = (name: string): number | undefined => {
    const v = p.get(name);
    if (v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  try {
    const db = openDb();
    let costsDb: ReturnType<typeof openCostsDb> = null;
    try { costsDb = openCostsDb(); } catch { costsDb = null; }
    try {
      const result = listSessions(db, {
        costsDb,
        container: p.get('container') || undefined,
        kind: p.get('kind') || undefined,
        since: numParam('since'),
        limit: numParam('limit'),
        active: p.get('active') === '1',
      });
      if (result.error) return NextResponse.json({ error: 'Could not read the sessions' }, { status: 500 });
      return NextResponse.json(result);
    } finally {
      try { costsDb?.close(); } catch { /* ignore */ }
      db.close();
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
