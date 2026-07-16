/**
 * GET /api/setup/agent-image
 *
 * Checks if openclaw-agent-base:latest exists locally or needs building.
 * Returns status and a hint for the UI.
 */
import { NextResponse } from 'next/server';
import { exec } from 'child_process';

export const dynamic = 'force-dynamic';

/**
 * Build lock — prevents parallel docker builds.
 * In-memory only; resets on server restart (acceptable for setup phase).
 */
let isBuilding = false;

export async function GET(): Promise<NextResponse> {
  try {
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

/**
 * POST /api/setup/agent-image
 *
 * Builds openclaw-agent-base:latest from agent-templates/base-image/Dockerfile.
 * Streams progress via SSE so the setup wizard can show a live progress bar.
 *
 * Only one build at a time — returns 409 if a build is already running.
 * Cleans up the docker build process if the client disconnects.
 */
export async function POST(): Promise<Response> {
  if (isBuilding) {
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

      let child: ReturnType<typeof import('child_process').exec> | null = null;

      // Abort handler — kills docker build if client disconnects.
      // controller.signal is a newer API; use optional chaining with type cast.
      const ctrl = controller as ReadableStreamDefaultController & { signal?: AbortSignal };
      ctrl.signal?.addEventListener('abort', () => {
        if (child && !child.killed) {
          child.kill('SIGTERM');
        }
        isBuilding = false;
      });

      try {
        // Check if already exists
        try {
          const exists = await new Promise<string>((resolve, reject) => {
            exec(
              'docker image inspect openclaw-agent-base:latest --format "{{.ID}}" 2>/dev/null',
              { timeout: 3000 },
              (err, stdout) => { if (err) reject(err); else resolve(stdout.trim()); },
            );
          });
          if (exists) {
            send(JSON.stringify({ type: 'complete', message: 'Image already exists' }));
            controller.close();
            return;
          }
        } catch { /* doesn't exist — continue to build */ }

        isBuilding = true;
        send(JSON.stringify({ type: 'status', message: 'Building agent base image...' }));

        const dockerfileDir = `${process.cwd()}/agent-templates/base-image`;

        const { exec: spawnExec } = await import('child_process');
        child = spawnExec(
          `docker build -t openclaw-agent-base:latest .`,
          { cwd: dockerfileDir, maxBuffer: 1024 * 1024 * 10 },
        );

        child.stdout?.on('data', (chunk: string) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
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
          child!.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`docker build exited with code ${code}`));
          });
          child!.on('error', reject);
        });

        send(JSON.stringify({ type: 'complete', message: 'Agent base image built successfully' }));
      } catch (e: unknown) {
        send(JSON.stringify({
          type: 'error',
          message: (e as Error).message || 'Failed to build agent image',
        }));
      } finally {
        isBuilding = false;
        controller.close();
      }
    },
    cancel() {
      isBuilding = false;
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
