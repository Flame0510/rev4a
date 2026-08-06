import { NextResponse, type NextRequest } from 'next/server';

import { patchCronJob, removeCronJob } from '@/lib/openclaw-cron';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;

  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const allowed: Record<string, unknown> = {};
  if (typeof body.enabled === 'boolean') allowed.enabled = body.enabled;
  if (typeof body.containerName === 'string') {
    if (!CONTAINER_NAME_RE.test(body.containerName)) {
      return NextResponse.json({ error: 'Invalid containerName format' }, { status: 400 });
    }
    allowed.containerName = body.containerName;
  }

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: 'No patchable fields provided' }, { status: 400 });
  }

  const result = patchCronJob(id, allowed);
  if (!result.ok) {
    const status = result.error?.includes('not found') ? 404
      : result.error?.includes('gateway') || result.error?.includes('Failed') ? 502
      : 500;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json(result.job);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const containerName = searchParams.get('containerName') ?? undefined;

  if (containerName !== undefined && !CONTAINER_NAME_RE.test(containerName)) {
    return NextResponse.json({ error: 'Invalid containerName format' }, { status: 400 });
  }

  const result = removeCronJob(id, containerName);
  if (!result.ok) {
    const status = result.error?.includes('not found') ? 404 : 502;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ ok: true });
}
