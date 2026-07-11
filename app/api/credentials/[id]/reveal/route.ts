import { NextResponse } from 'next/server';
import { getProfile, revealSecret } from '@/lib/credentials/vault';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const profile = getProfile(id);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const secret = revealSecret(id);
    return NextResponse.json({ secret });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
