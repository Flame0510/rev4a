import { type NextRequest } from "next/server";
/**
 * POST /api/agents/download-image
 *
 * Downloads one OpenClaw version of the agent base image in the background.
 * Body (optional): `{ "version": "2026.9.3" }` — a supported version; without it, the
 * newest supported version the registry publishes. Returns 202 with the version;
 * poll GET /api/agents/image-status for completion.
 *
 * Requires auth. 400 for an unsupported version, 409 if a download is already running.
 */
import { NextResponse } from 'next/server';
import { defaultDownloadVersion, downloadAgentImage, getIsDownloading } from '@/lib/buildAgentImage';
import { isSupportedVersion } from '@/lib/agent-versions';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  if (getIsDownloading()) {
    return NextResponse.json(
      { error: 'A download is already in progress' },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => null)) as { version?: unknown } | null;
  if (body?.version !== undefined && !isSupportedVersion(body.version)) {
    return NextResponse.json({ error: 'version must be an OpenClaw version this Rev4a supports' }, { status: 400 });
  }
  const version = (body?.version as string | undefined) ?? (await defaultDownloadVersion());

  // Checked again here, next to the start: the first check and this one are separated by
  // awaits, so two requests can pass it together. The loser of the race is refused inside
  // downloadAgentImage, and that rejection would be swallowed by the catch below — the
  // route would answer 202 for a download it never started.
  if (getIsDownloading()) {
    return NextResponse.json({ error: 'A download is already in progress' }, { status: 409 });
  }

  // Start download in background — fire and forget
  downloadAgentImage({ version }).catch((e: unknown) => {
    console.error(`[download-image] OpenClaw ${version}:`, (e as Error).message);
  });

  return NextResponse.json({ started: true, version }, { status: 202 });
}
