import { NextResponse, type NextRequest } from 'next/server';
import { openDb } from '@/lib/db';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { recentEvents } from '@/lib/agent-sessions-db';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { searchParams } = new URL(request.url);
  const parsed = Number.parseInt(searchParams.get('limit') ?? '50', 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 50;
  try {
    const db = openDb();
    try {
      return NextResponse.json(recentEvents(db, { limit }));
    } finally {
      db.close();
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
