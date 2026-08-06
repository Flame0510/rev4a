import { NextResponse, type NextRequest } from 'next/server';
import { getMemoryContextSnapshot } from '@/lib/memory-context';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;

  try {
    return NextResponse.json(getMemoryContextSnapshot());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
