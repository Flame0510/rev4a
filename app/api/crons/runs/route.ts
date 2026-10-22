import { NextResponse, type NextRequest } from 'next/server';

import { getCronRuns } from '@/lib/openclaw-cron';
import { isValidAgentContainer, listAgentContainers } from '@/lib/agent-containers';
import { checkCronRequest } from '@/lib/cron-ids';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // docker exec + gateway API call can take up to 15s

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { searchParams } = new URL(request.url);
  const containerName = searchParams.get('containerName');
  const jobId = searchParams.get('jobId');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10) || 20, 100);

  if (!containerName) {
    return NextResponse.json({ error: 'Missing or invalid containerName' }, { status: 400 });
  }
  if (!jobId || jobId.length < 8) {
    return NextResponse.json({ error: 'Missing or invalid jobId' }, { status: 400 });
  }
  const target = await checkCronRequest(
    { jobId, containerName },
    { isValidContainer: isValidAgentContainer, listContainers: listAgentContainers },
  );
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });

  const result = getCronRuns(containerName, jobId, limit);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, entries: [] }, { status: 502 });
  }

  return NextResponse.json({ entries: result.entries });
}
