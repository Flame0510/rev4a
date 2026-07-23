import { NextResponse, type NextRequest } from 'next/server';

import { patchCronJob } from '@/lib/openclaw-cron';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {

  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'Only the enabled field can be patched, must be boolean' }, { status: 400 });
  }

  const result = await patchCronJob(id, { enabled: body.enabled });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error?.includes('not found') ? 404 : 500 });
  }

  return NextResponse.json(result.job);
}
