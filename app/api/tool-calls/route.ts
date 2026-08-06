import { NextResponse, type NextRequest } from 'next/server';
import { openDb } from '@/lib/db';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number.parseInt(searchParams.get('limit') ?? '50', 10), 200);
  const sessionId = searchParams.get('session_id');
  try {
    const db = openDb();
    const rows = sessionId
      ? db
          .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY ts DESC LIMIT ?')
          .all(sessionId, limit)
      : db.prepare('SELECT * FROM tool_calls ORDER BY ts DESC LIMIT ?').all(limit);
    db.close();
    return NextResponse.json(rows);
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}
