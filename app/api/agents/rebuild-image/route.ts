/**
 * POST /api/agents/rebuild-image
 *
 * Rebuilds the openclaw-agent-base image with the latest Dockerfile.
 * Requires auth. Streams progress via SSE.
 *
 * Unlike /api/setup/agent-image, this always rebuilds (force: true)
 * and requires authentication.
 */
import { buildAgentImage, getIsBuilding } from '@/lib/buildAgentImage';

export const dynamic = 'force-dynamic';

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
          force: true,
          onEvent: send,
          signal: ctrl.signal,
        });
      } catch (e: unknown) {
        send(JSON.stringify({
          type: 'error',
          message: (e as Error).message || 'Failed to rebuild agent image',
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
