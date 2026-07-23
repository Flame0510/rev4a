import { NextResponse, type NextRequest } from 'next/server';

import { getCronRuns } from '@/lib/openclaw-cron';

export const dynamic = 'force-dynamic';

const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const containerName = searchParams.get('containerName');
  const jobId = searchParams.get('jobId');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10) || 20, 100);

  if (!containerName || !CONTAINER_NAME_RE.test(containerName)) {
    return NextResponse.json({ error: 'Missing or invalid containerName' }, { status: 400 });
  }
  if (!jobId || typeof jobId !== 'string' || jobId.length < 8) {
    return NextResponse.json({ error: 'Missing or invalid jobId' }, { status: 400 });
  }

  const result = getCronRuns(containerName, jobId, limit);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, entries: [] }, { status: 502 });
  }

  return NextResponse.json({ entries: result.entries });
}
