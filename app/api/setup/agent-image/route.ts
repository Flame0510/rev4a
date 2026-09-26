/**
 * GET /api/setup/agent-image
 *
 * Whether a supported OpenClaw version of the agent base image is downloaded.
 * Returns `{ exists, version }`, the version being the newest one present.
 *
 * POST /api/setup/agent-image
 *
 * Downloads the newest supported version the registry publishes, and streams
 * progress via SSE so the setup wizard can show a live progress bar. Nothing is
 * downloaded when that version is already here.
 *
 * Only one download at a time — returns 409 if already running.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { downloadAgentImage, getIsDownloading } from '@/lib/buildAgentImage';
import { requireAuthIfConfigured } from '@/lib/rev4a-auth';
import { dockerAvailable } from '@/lib/docker-socket';
import { listLocalAgentImages, newestLocalSupportedVersion } from '@/lib/agent-images';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthIfConfigured(request);
  if (denied) return denied;
  if (!dockerAvailable()) {
    return NextResponse.json({ exists: false, version: null });
  }
  try {
    const version = newestLocalSupportedVersion(await listLocalAgentImages());
    return NextResponse.json({ exists: version !== null, version });
  } catch {
    return NextResponse.json({ exists: false, version: null });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const denied = await requireAuthIfConfigured(request);
  if (denied) return denied;
  if (getIsDownloading()) {
    return new Response(
      JSON.stringify({ error: 'A download is already in progress' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();
  // Aborted when the client goes away (the stream's cancel()), which stops docker.
  const abort = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch { /* stream closed */ }
      };

      try {
        await downloadAgentImage({ onEvent: send, signal: abort.signal });
      } catch (e: unknown) {
        send(JSON.stringify({
          type: 'error',
          message: (e as Error).message || 'Failed to download agent image',
        }));
      }
      controller.close();
    },
    // A ReadableStreamDefaultController has no signal of its own; this is the hook the
    // runtime calls when the client disconnects.
    cancel() { abort.abort(); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
