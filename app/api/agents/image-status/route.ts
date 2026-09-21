/**
 * GET /api/agents/image-status
 *
 * Which OpenClaw versions of the agent base image are downloaded, whether the
 * registry publishes a newer supported version, and whether a download is running.
 *
 * ImageDownloadBanner polls this every 2 s. The local part is two Docker API calls;
 * the registry lookup is cached for ten minutes and shared by concurrent requests
 * (lib/agent-images.ts), so polling does not hit the network.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDownloadingVersion, getIsDownloading } from '@/lib/buildAgentImage';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { dockerAvailable } from '@/lib/docker-socket';
import { listLocalAgentImages, localSupportedVersions, remoteSupportedVersions, type LocalAgentImage } from '@/lib/agent-images';
import { compareVersions } from '@/lib/agent-versions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  const base = { downloading: getIsDownloading(), downloadingVersion: getDownloadingVersion() };

  if (!dockerAvailable()) {
    return NextResponse.json({
      ...base, exists: false, needsUpdate: true, localVersions: [], newestLocal: null, available: null, registryReachable: false,
    });
  }

  let images: LocalAgentImage[] = [];
  try {
    images = await listLocalAgentImages();
  } catch {
    // Docker answered nothing usable: report no local image.
  }
  const localVersions = localSupportedVersions(images);
  const newestLocal = localVersions[0] ?? null;

  const remote = await remoteSupportedVersions();
  const available = remote?.find(
    (v) => !localVersions.includes(v) && (!newestLocal || compareVersions(v, newestLocal) > 0),
  ) ?? null;

  return NextResponse.json({
    ...base,
    exists: newestLocal !== null,
    needsUpdate: newestLocal === null || available !== null,
    localVersions,
    newestLocal,
    available,
    registryReachable: remote !== null,
  });
}
