import { type NextRequest } from "next/server";
/**
 * GET /api/agents/image-status
 *
 * Reports whether the openclaw-agent-base image is present, whether a download
 * is in flight, and whether a newer image exists in the registry.
 *
 * The four fields cost wildly different amounts, which is what makes this route
 * worth structuring carefully. ImageDownloadBanner polls it every 2s to animate
 * download progress, so anything slow in here is paid over and over:
 *
 *   downloading   in-memory flag                          free
 *   error         local                                   free
 *   exists        one `docker image inspect`              ~0.5s
 *   needsUpdate   `docker manifest inspect` over the net  ~3.4s
 *
 * The route used to compute all of them, synchronously, on every poll — a 2s
 * interval driving a ~5s blocking call, so the whole server sat frozen for as
 * long as the agents page stayed open. It also ran `docker version` three times
 * per request (once inside each helper) just to ask whether Docker was up, at
 * ~2s a call, and inspected the same image three times over.
 *
 * Now: Docker liveness comes from the socket check in lib/docker-socket (a
 * cached filesystem stat), the image is inspected once, everything is async, and
 * the registry lookup — the only genuinely expensive part — is cached. The base
 * image changes when a release is published, not every two seconds.
 */
import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getIsDownloading } from '@/lib/buildAgentImage';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { dockerAvailable } from '@/lib/docker-socket';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

const REGISTRY_IMAGE = 'ghcr.io/flame0510/rev4a/openclaw-agent-base:latest';
const LOCAL_IMAGE = 'openclaw-agent-base:latest';
const REGISTRY_PREFIX = 'ghcr.io/flame0510/rev4a/openclaw-agent-base@';

/**
 * How long a registry lookup is reused. Long enough that a 2s poll doesn't hit
 * the network, short enough that a freshly published base image surfaces on its
 * own. The cost of being stale here is a banner appearing a few minutes late.
 */
const REMOTE_TTL_MS = 10 * 60 * 1000;

let remoteCache: { digest: string | null; at: number } | null = null;
/** Shared across concurrent requests so a burst of polls triggers one lookup. */
let remoteInFlight: Promise<string | null> | null = null;

/** The local image's ID and its registry digest, from a single inspect. */
async function inspectLocalImage(): Promise<{ id: string; registryDigest: string | null } | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['image', 'inspect', LOCAL_IMAGE, '--format', '{{json .}}'],
      { encoding: 'utf-8', timeout: 5000 },
    );
    const info = JSON.parse(stdout) as { Id?: string; RepoDigests?: string[] };
    const fromRegistry = (info.RepoDigests ?? []).find((d) => d.startsWith(REGISTRY_PREFIX));
    return {
      id: info.Id ?? '',
      registryDigest: fromRegistry ? fromRegistry.split('@')[1] ?? null : null,
    };
  } catch {
    return null;
  }
}

/** Manifest digest of the published image, cached for REMOTE_TTL_MS. */
async function getRemoteDigest(): Promise<string | null> {
  if (remoteCache && Date.now() - remoteCache.at < REMOTE_TTL_MS) return remoteCache.digest;
  if (remoteInFlight) return remoteInFlight;

  remoteInFlight = (async () => {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['manifest', 'inspect', REGISTRY_IMAGE, '--verbose'],
        { encoding: 'utf-8', timeout: 15000 },
      );
      const manifest = JSON.parse(stdout) as { Descriptor?: { digest?: string } };
      // The descriptor digest is what RepoDigests can be compared against;
      // config.digest is a different hash entirely.
      return manifest?.Descriptor?.digest ?? null;
    } catch {
      return null;
    }
  })();

  try {
    const digest = await remoteInFlight;
    remoteCache = { digest, at: Date.now() };
    return digest;
  } finally {
    remoteInFlight = null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  const downloading = getIsDownloading();

  if (!dockerAvailable()) {
    return NextResponse.json({ exists: false, needsUpdate: true, downloading, localId: null });
  }

  const local = await inspectLocalImage();
  if (!local) {
    return NextResponse.json({ exists: false, needsUpdate: true, downloading, localId: null });
  }

  // A cached registry digest answers immediately; a cold one costs a network
  // round trip, but only once per TTL rather than once per poll.
  const remoteDigest = await getRemoteDigest();

  let needsUpdate = false;
  if (remoteDigest) {
    // No registry digest locally means the image was built here and never
    // pulled, so it can't be compared — treat it as updatable.
    needsUpdate = local.registryDigest ? local.registryDigest !== remoteDigest : true;
  }

  return NextResponse.json({
    exists: true,
    needsUpdate,
    downloading,
    localId: local.id || null,
  });
}
