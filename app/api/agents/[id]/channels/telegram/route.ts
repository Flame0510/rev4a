import { NextResponse, type NextRequest } from 'next/server';
import { setTelegramConfig, removeTelegram } from '@/lib/channelManager';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;

  try {
    const body = await request.json();

    if (!body.botToken || typeof body.botToken !== 'string' || !body.botToken.trim()) {
      return NextResponse.json({ error: 'botToken is required' }, { status: 400 });
    }

    const result = await setTelegramConfig(id, {
      botToken: body.botToken.trim(),
      dmPolicy: body.dmPolicy,
      allowFrom: body.allowFrom,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;

  const result = await removeTelegram(id);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
