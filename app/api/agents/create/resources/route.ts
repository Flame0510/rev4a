import { NextResponse, type NextRequest } from 'next/server';
import { listLocalAgentImages, newestLocalSupportedVersion } from '@/lib/agent-images';
import { parseLimitMb } from '@/lib/agent-memory-limit';
import { previewAgentResources } from '@/lib/agent-resource-preflight';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  let limitMb: number | null;
  try {
    limitMb = parseLimitMb(request.nextUrl.searchParams.get('limitMb'));
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 400 });
  }

  let version: string | null;
  try {
    version = newestLocalSupportedVersion(await listLocalAgentImages({ timeoutMs: 5000 }));
  } catch {
    return NextResponse.json({
      ok: false,
      code: 'unknown-host',
      error: 'Docker could not be read. Check that Docker is running, then retry.',
    });
  }
  if (!version) {
    return NextResponse.json({
      ok: false,
      code: 'no-image',
      error: 'No supported agent image is downloaded. Download it from the Agents page first.',
    });
  }

  // An empty id cannot match a running agent or a real Create reservation.
  const preview = await previewAgentResources({ version, operation: 'create', targetAgentId: '', limitMb });
  return NextResponse.json({ ...preview, version });
}
