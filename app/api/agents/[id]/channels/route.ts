import { NextResponse, type NextRequest } from 'next/server';
import { getChannels } from '@/lib/channelManager';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = getChannels(id);
  return NextResponse.json(result);
}
