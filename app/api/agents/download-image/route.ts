import { type NextRequest } from "next/server";
/**
 * POST /api/agents/download-image
 *
 * Triggers a fresh download (pull) of the openclaw-agent-base image.
 * Returns 202 Accepted immediately — the operation runs in the background.
 * Poll GET /api/agents/download-progress and
 * GET /api/agents/image-status for completion.
 *
 * Requires auth. Returns 409 if a download is already running.
 */
import { NextResponse } from 'next/server';
import { downloadAgentImage, getIsDownloading } from '@/lib/buildAgentImage';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (getIsDownloading()) {
    return NextResponse.json(
      { error: 'A download is already in progress' },
      { status: 409 },
    );
  }

  // Start download in background — fire and forget
  downloadAgentImage({ force: true }).catch(() => {
    // Errors are logged to the download log file
  });

  return NextResponse.json({ started: true }, { status: 202 });
}
