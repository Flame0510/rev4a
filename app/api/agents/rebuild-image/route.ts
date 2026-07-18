/**
 * POST /api/agents/rebuild-image
 *
 * Triggers a rebuild of the openclaw-agent-base image.
 * Returns 202 Accepted immediately — the build runs in the background.
 * Poll GET /api/agents/build-logs for progress and
 * GET /api/agents/image-status for completion.
 *
 * Requires auth. Returns 409 if a build is already running.
 */
import { NextResponse } from 'next/server';
import { buildAgentImage, getIsBuilding } from '@/lib/buildAgentImage';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  if (getIsBuilding()) {
    return NextResponse.json(
      { error: 'A build is already in progress' },
      { status: 409 },
    );
  }

  // Start build in background — fire and forget
  buildAgentImage({ force: true }).catch(() => {
    // Errors are logged to the build log file
  });

  return NextResponse.json({ started: true }, { status: 202 });
}
