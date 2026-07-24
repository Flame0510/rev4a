/**
 * GET /api/setup/agent-image
 *
 * Checks if openclaw-agent-base:latest exists locally or needs building.
 * Returns status and a hint for the UI.
 *
 * POST /api/setup/agent-image
 *
 * Builds openclaw-agent-base:latest from agent-templates/base-image/Dockerfile.
 * Streams progress via SSE so the setup wizard can show a live progress bar.
 *
 * Only one build at a time — returns 409 if a build is already running.
 * Cleans up the docker build process if the client disconnects.
 */
import { NextResponse } from 'next/server';
import { buildAgentImage, getIsBuilding } from '@/lib/buildAgentImage';
import { execSync } from 'child_process';

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

export async function GET(): Promise<NextResponse> {
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

export async function POST(): Promise<Response> {
  if (getIsBuilding()) {
    return new Response(
      JSON.stringify({ error: 'A build is already in progress' }),
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
        await buildAgentImage({
          force: false, // setup: skip if already exists
          onEvent: send,
          signal: ctrl.signal,
        });
      } catch (e: unknown) {
        send(JSON.stringify({
          type: 'error',
          message: (e as Error).message || 'Failed to build agent image',
        }));
      }
      controller.close();
    },
    cancel() { /* buildAgentImage handles cleanup via signal */ },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
