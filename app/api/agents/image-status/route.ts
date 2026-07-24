/**
 * GET /api/agents/image-status
 *
 * Checks whether the openclaw-agent-base image is up to date with the
 * current Dockerfile. The image carries a label `olympus.dockerfile_hash`
 * set at build time; we compare it against the current Dockerfile SHA256.
 */
import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { getDockerfileHash, getIsBuilding, getBuildLogPath } from '@/lib/buildAgentImage';

export const dynamic = 'force-dynamic';

/** Check whether docker CLI is usable. */
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

function getImageHash(): string | null {
  if (!dockerOk()) return null;
  try {
    const label = execSync(
      `docker image inspect openclaw-agent-base:latest --format '{{index .Config.Labels "olympus.dockerfile_hash"}}' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    return label || null;
  } catch {
    return null;
  }
}

function imageExists(): boolean {
  if (!dockerOk()) return false;
  try {
    execSync(
      'docker image inspect openclaw-agent-base:latest --format "{{.ID}}" 2>/dev/null',
      { timeout: 3000 },
    );
    return true;
  } catch {
    return false;
  }
}

export async function GET(): Promise<NextResponse> {
  const exists = imageExists();
  const dockerfileHash = getDockerfileHash();

  if (!exists) {
    return NextResponse.json({
      exists: false,
      needsRebuild: true,
      building: getIsBuilding(),
      dockerfileHash,
    });
  }

  const imageHash = getImageHash();
  // If imageHash is null, the image was built before hash tracking was added.
  // Treat as mismatch so the user can rebuild with the label.
  const needsRebuild = imageHash === null || (dockerfileHash !== null && dockerfileHash !== imageHash);

  return NextResponse.json({
    exists: true,
    needsRebuild,
    building: getIsBuilding(),
    buildLog: getBuildLogPath() ? true : false,
    dockerfileHash,
    imageHash: imageHash || null,
  });
}
