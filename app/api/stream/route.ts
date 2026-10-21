import { type NextRequest } from 'next/server';
import { DB_PATH } from '@/lib/db';
import { openCostsDb } from '@/lib/costs-db';
import Database from 'better-sqlite3';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { dashboardCosts } from '@/lib/agent-costs';
import { listSessions, recentEvents, sessionsChanged, sessionsVersion } from '@/lib/agent-sessions-db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  let lastEventId = 0;
  let lastSessionsVersion: number | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const poll = () => {
        try {
          const db = new Database(DB_PATH, { readonly: true });
          let newEvents: { id: number }[] = [];
          let sessions: ReturnType<typeof listSessions>['sessions'] | null = null;
          let costsDb: ReturnType<typeof openCostsDb> = null;
          try {
            try { newEvents = recentEvents(db, { limit: 20, afterId: lastEventId, ascending: true }) as { id: number }[]; } catch { newEvents = []; }
            // The sessions frame is sent only when the collector bumped the version (and on the first poll),
            // with the same list GET /api/sessions answers (same window, same cap). A failed read keeps the last frame.
            const version = sessionsVersion(db);
            if (sessionsChanged(lastSessionsVersion, version)) {
              try { costsDb = openCostsDb(); } catch { costsDb = null; }
              const listed = listSessions(db, { costsDb });
              if (!listed.error) {
                sessions = listed.sessions;
                lastSessionsVersion = version;
              }
            }
          } finally {
            try { costsDb?.close(); } catch { /* ignore */ }
            db.close();
          }
          // What the agents' OpenClaw priced today (UTC day), like GET /api/costs.
          const costs = dashboardCosts();

          if (newEvents.length > 0) {
            lastEventId = newEvents[newEvents.length - 1].id;
            send({ type: 'events', data: newEvents });
          }
          if (sessions) send({ type: 'sessions', data: sessions });
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
