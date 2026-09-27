import { type NextRequest } from 'next/server';
import { DB_PATH } from '@/lib/db';
import Database from 'better-sqlite3';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { dashboardCosts } from '@/lib/agent-costs';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  let lastEventId = 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const poll = () => {
        try {
          const db = new Database(DB_PATH, { readonly: true });
          const newEvents = db
            .prepare(
              `SELECT e.*, s.label AS session_label FROM events e
               LEFT JOIN sessions s ON e.session_id = s.session_id
               WHERE e.id > ? ORDER BY e.ts ASC LIMIT 20`,
            )
            .all(lastEventId) as { id: number }[];
          const sessions = db
            .prepare(`SELECT s.*, l.label AS lineage_label, l.agent_name AS lineage_agent_name
                      FROM sessions s
                      LEFT JOIN lineage l ON s.session_id = l.child_id
                      ORDER BY s.started_at DESC LIMIT 100`)
            .all();
          db.close();
          // What the agents' OpenClaw priced today (UTC day), like GET /api/costs.
          const costs = dashboardCosts();

          if (newEvents.length > 0) {
            lastEventId = newEvents[newEvents.length - 1].id;
            send({ type: 'events', data: newEvents });
          }
          send({ type: 'sessions', data: sessions });
          send({ type: 'costs', data: { today: costs?.today ?? 0 } });
        } catch {
          // Ignore DB read errors to keep stream alive.
        }
      };

      poll();
      const interval = setInterval(poll, 5000);

      request.signal.addEventListener('abort', () => {
        clearInterval(interval);
        controller.close();
      });
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
