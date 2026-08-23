/**
 * GET /api/setup/agent-image
 *
 * Checks if openclaw-agent-base:latest exists locally or needs downloading.
 * Returns status and a hint for the UI.
 *
 * POST /api/setup/agent-image
 *
 * Downloads openclaw-agent-base:latest from ghcr.io (public registry).
 * Streams progress via SSE so the setup wizard can show a live progress bar.
 *
 * Only one download at a time — returns 409 if already running.
 * Cleans up the docker process if the client disconnects.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { downloadAgentImage, getIsDownloading } from '@/lib/buildAgentImage';
import { execSync } from 'child_process';
import { requireAuthIfConfigured } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthIfConfigured(request);
  if (denied) return denied;
  if (!dockerOk()) {
    return NextResponse.json({ exists: false });
  }
  try {
    const { exec } = await import('child_process');
    const result = await new Promise<string>((resolve, reject) => {
      exec(
        'docker image inspect openclaw-agent-base:latest --format "{{.ID}}" 2>/dev/null',
        { timeout: 5000 },
        (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim());
        },
      );
    });
    if (result) {
      return NextResponse.json({ exists: true, imageId: result });
    }
    return NextResponse.json({ exists: false });
  } catch {
    return NextResponse.json({ exists: false });
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

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch { /* stream closed */ }
      };

      const ctrl = controller as ReadableStreamDefaultController & { signal?: AbortSignal };

      try {
        await downloadAgentImage({
          force: false, // setup: skip if already exists
          onEvent: send,
          signal: ctrl.signal,
        });
      } catch (e: unknown) {
        send(JSON.stringify({
          type: 'error',
          message: (e as Error).message || 'Failed to download agent image',
        }));
      }
      controller.close();
    },
    cancel() { /* downloadAgentImage handles cleanup via signal */ },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
