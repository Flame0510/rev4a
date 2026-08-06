import { NextResponse, type NextRequest } from 'next/server';
import { getChannels } from '@/lib/channelManager';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;
  const result = getChannels(id);
  return NextResponse.json(result);
}
