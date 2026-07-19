import { NextResponse, type NextRequest } from 'next/server';
import { getPairings, approvePairing, revokePairing } from '@/lib/channelManager';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = getPairings(id);
  return NextResponse.json(result);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const body = await request.json();

    if (!body.code || typeof body.code !== 'string' || !body.code.trim()) {
      return NextResponse.json({ error: 'Pairing code is required' }, { status: 400 });
    }

    const result = approvePairing(id, body.code.trim());

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const senderId = request.nextUrl.searchParams.get('senderId');

  if (!senderId || !senderId.trim()) {
    return NextResponse.json({ error: 'senderId query param is required' }, { status: 400 });
  }

  const result = revokePairing(id, senderId);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
