import { type NextRequest } from "next/server";
/**
 * GET /api/agents/image-status
 *
 * Checks whether the openclaw-agent-base image is present and up to date.
 * Compares the local image digest with the remote registry digest
 * (public image on ghcr.io, no auth needed).
 */
import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { getIsDownloading } from '@/lib/buildAgentImage';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

const REGISTRY_IMAGE = 'ghcr.io/flame0510/rev4a/openclaw-agent-base:latest';
const LOCAL_IMAGE = 'openclaw-agent-base:latest';

function dockerOk(): boolean {
  try {
    execSync('docker version --format "{{.Client.Version}}" 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function localImageExists(): boolean {
  if (!dockerOk()) return false;
  try {
    execSync(
      `docker image inspect ${LOCAL_IMAGE} --format "{{.ID}}" 2>/dev/null`,
      { timeout: 3000 },
    );
    return true;
  } catch {
    return false;
  }
}

function getLocalImageId(): string | null {
  if (!dockerOk()) return null;
  try {
    return execSync(
      `docker image inspect ${LOCAL_IMAGE} --format "{{.ID}}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim() || null;
  } catch {
    return null;
  }
}

/** Fetch the remote manifest digest from ghcr.io (public, no auth). */
function getRemoteDigest(): string | null {
  if (!dockerOk()) return null;
  try {
    const out = execSync(
      `docker manifest inspect ${REGISTRY_IMAGE} --verbose 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    const manifest = JSON.parse(out);
    // Use the manifest descriptor digest (comparable with RepoDigests),
    // not config.digest (which is a different hash).
    return manifest?.Descriptor?.digest || null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  const exists = localImageExists();
  const localId = getLocalImageId();
  const downloading = getIsDownloading();

  if (!exists) {
    return NextResponse.json({
      exists: false,
      needsUpdate: true,
      downloading,
      localId: null,
    });
  }

  // Compare local image digest with remote registry digest.
  // If they differ, a newer image is available.
  let needsUpdate = false;
  const remoteDigest = getRemoteDigest();

  if (remoteDigest && localId) {
    // localId is the image ID (e.g. sha256:abc123...).
    // Extract it from any RepoDigest that references the registry.
    try {
      const inspect = JSON.parse(
        execSync(
          `docker image inspect ${LOCAL_IMAGE} --format '{{json .}}' 2>/dev/null`,
          { encoding: 'utf-8', timeout: 3000 },
        ),
      );
      const localRepoDigests: string[] = inspect?.RepoDigests || [];
      const registryDigest = localRepoDigests.find((d: string) =>
        d.startsWith('ghcr.io/flame0510/rev4a/openclaw-agent-base@'),
      );

      if (registryDigest) {
        // Extract sha256:... from "ghcr.io/...@sha256:xxx"
        const localDigest = registryDigest.split('@')[1] || '';
        needsUpdate = localDigest !== remoteDigest;
      } else {
        // Image was built locally, never pulled — needs update
        needsUpdate = true;
      }
    } catch {
      // Can't determine — assume up to date
    }
  }

  return NextResponse.json({
    exists: true,
    needsUpdate,
    downloading,
    localId,
  });
}
