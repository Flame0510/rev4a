/**
 * GET /api/setup/agent-image
 *
 * Checks if openclaw-agent-base:latest exists locally or needs building.
 * Returns status and a hint for the UI.
 */
import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  try {
    const result = execSync(
      'docker image inspect openclaw-agent-base:latest --format "{{.ID}}" 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (result) {
      return NextResponse.json({ exists: true, imageId: result });
    }
    return NextResponse.json({ exists: false });
  } catch {
    return NextResponse.json({ exists: false });
  }
}

/**
 * POST /api/setup/agent-image
 *
 * Builds openclaw-agent-base:latest from agent-templates/base-image/Dockerfile.
 * Streams progress via SSE so the setup wizard can show a live progress bar.
 */
export async function POST(): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        // Check if already exists
        try {
          execSync(
            'docker image inspect openclaw-agent-base:latest --format "{{.ID}}" 2>/dev/null',
            { timeout: 3000 },
          );
          send(JSON.stringify({ type: 'complete', message: 'Image already exists' }));
          controller.close();
          return;
        } catch { /* doesn't exist — continue to build */ }

        send(JSON.stringify({ type: 'status', message: 'Building agent base image...' }));

        const dockerfileDir = `${process.cwd()}/agent-templates/base-image`;

        const { exec } = await import('child_process');
        const child = exec(
          `docker build -t openclaw-agent-base:latest .`,
          { cwd: dockerfileDir, maxBuffer: 1024 * 1024 * 10 },
        );

        child.stdout?.on('data', (chunk: string) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            // Parse Docker build output for progress
            if (line.startsWith('Step')) {
              send(JSON.stringify({ type: 'step', message: line }));
            } else if (line.includes('Downloading') || line.includes('Extracting')) {
              send(JSON.stringify({ type: 'progress', message: line }));
            }
          }
        });

        child.stderr?.on('data', (chunk: string) => {
          const text = chunk.toString().trim();
          if (text) send(JSON.stringify({ type: 'progress', message: text }));
        });

        await new Promise<void>((resolve, reject) => {
          child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`docker build exited with code ${code}`));
          });
          child.on('error', reject);
        });

        send(JSON.stringify({ type: 'complete', message: 'Agent base image built successfully' }));
      } catch (e: unknown) {
        send(JSON.stringify({
          type: 'error',
          message: (e as Error).message || 'Failed to build agent image',
        }));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
