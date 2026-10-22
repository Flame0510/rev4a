import { NextResponse, type NextRequest } from 'next/server';

import { patchCronJob, removeCronJob } from '@/lib/openclaw-cron';
import { isValidAgentContainer, listAgentContainers } from '@/lib/agent-containers';
import { checkCronRequest } from '@/lib/cron-ids';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

const checkTarget = (jobId: string, containerName: unknown) =>
  checkCronRequest({ jobId, containerName }, { isValidContainer: isValidAgentContainer, listContainers: listAgentContainers });

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
  if (typeof body.containerName === 'string') allowed.containerName = body.containerName;

  if (typeof allowed.containerName !== 'string') {
    return NextResponse.json({ error: 'containerName is required' }, { status: 400 });
  }
  if (typeof allowed.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled (boolean) is required' }, { status: 400 });
  }

  const target = await checkTarget(id, allowed.containerName);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });

  const result = patchCronJob(id, allowed);
  if (!result.ok) {
    const status = result.badRequest ? 400
      : result.error?.includes('not found') ? 404
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

  if (!containerName) {
    return NextResponse.json({ error: 'Missing or invalid containerName' }, { status: 400 });
  }
  const target = await checkTarget(id, containerName);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });

  const result = removeCronJob(id, containerName);
  if (!result.ok) {
    const status = result.badRequest ? 400 : result.error?.includes('not found') ? 404 : 502;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ ok: true });
}
