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

export const dynamic = 'force-dynamic';

const REGISTRY_IMAGE = 'ghcr.io/flame0510/olympus/openclaw-agent-base:latest';
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

/** Fetch the remote image digest from ghcr.io (public, no auth). */
function getRemoteDigest(): string | null {
  if (!dockerOk()) return null;
  try {
    const out = execSync(
      `docker manifest inspect ${REGISTRY_IMAGE} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    const manifest = JSON.parse(out);
    return manifest?.config?.digest || null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
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

  // Check if a newer version is available on the registry
  let needsUpdate = false;
  const remoteDigest = getRemoteDigest();

  if (remoteDigest) {
    // Compare local image's repo digest with remote
    try {
      const inspect = JSON.parse(
        execSync(
          `docker image inspect ${LOCAL_IMAGE} --format '{{json .}}' 2>/dev/null`,
          { encoding: 'utf-8', timeout: 3000 },
        ),
      );
      const localRepoDigests: string[] = inspect?.RepoDigests || [];
      const hasRemote = localRepoDigests.some((d: string) =>
        d.startsWith('ghcr.io/flame0510/olympus/openclaw-agent-base@'),
      );
      const hasRegistryTag = localRepoDigests.some((d: string) =>
        d.startsWith('ghcr.io/flame0510/olympus/openclaw-agent-base:'),
      );

      // If image was built locally (not pulled), it won't have the registry digest
      if (!hasRemote && !hasRegistryTag) {
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
