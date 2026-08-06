import { NextResponse, type NextRequest } from 'next/server';
import { getPairings, approvePairing, revokePairing } from '@/lib/channelManager';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

function getChannel(request: NextRequest): string {
  return request.nextUrl.searchParams.get('channel') || 'telegram';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;
  const channel = getChannel(request);
  const result = getPairings(id, channel);
  return NextResponse.json(result);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;
  const channel = getChannel(request);

  try {
    const body = await request.json();

    if (!body.code || typeof body.code !== 'string' || !body.code.trim()) {
      return NextResponse.json({ error: 'Pairing code is required' }, { status: 400 });
    }

    const result = approvePairing(id, body.code.trim(), channel);

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
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;
  const channel = getChannel(request);
  const senderId = request.nextUrl.searchParams.get('senderId');

  if (!senderId || !senderId.trim()) {
    return NextResponse.json({ error: 'senderId query param is required' }, { status: 400 });
  }

  const result = revokePairing(id, senderId, channel);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
