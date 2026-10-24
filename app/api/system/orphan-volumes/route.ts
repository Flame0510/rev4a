import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { listOrphanVolumes } from '@/lib/agent-volumes-server';

export const dynamic = 'force-dynamic';

/** `agent-*-data` volumes no container uses. Lists only; deleting is DELETE /[name]. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    return NextResponse.json({ volumes: await listOrphanVolumes() });
  } catch {
    return NextResponse.json({ error: 'Could not read the Docker volumes' }, { status: 502 });
  }
}
