import { NextResponse, type NextRequest } from 'next/server';
import { openDb } from '@/lib/db';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { activeSnoozes } from '@/lib/spend-alerts';
import { containersInText, getAgentDisplayNames, nameContainersInText } from '@/lib/agent-names';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface AnomalyData { vendor?: unknown; metric?: unknown; message?: unknown; threshold?: unknown; values?: unknown; container?: unknown; agent?: unknown; scope?: unknown; resolved?: unknown }

/**
 * GET /api/metrics/alerts?limit=10 — the latest `system_anomaly` events (the machine's CPU, RAM
 * or a disk over its threshold, and a container's process count or sustained memory; written
 * by daemon.js into events.db), newest first. A `container_oom` event (a process in an agent
 * container killed for lack of memory) also carries `container`, the container's name.
 * Optional `container=<name>` keeps only the events of that container (the events written
 * with a `container` field, or a spend alarm whose `agent` is that name; the machine-wide ones carry none). Other params are ignored. Nothing else in `events`: the generic
 * /api/events has no type filter.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as NextResponse;

  const container = request.nextUrl.searchParams.get('container');
  const agentId = request.nextUrl.searchParams.get('agent');
  // Either name keeps an event: the container's name, or the agent id a spend alarm was raised under.
  const filterNames = [container, agentId].filter((v): v is string => Boolean(v));
  const parsed = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  try {
    const db = openDb();
    try {
      // The container filter runs on the stored JSON, so it is applied in SQL by name
      // (json_extract, the name is a bound parameter) and the limit counts matches only.
      const marks = filterNames.map(() => '?').join(', ');
      const rows = (filterNames.length
        ? db
          .prepare(`SELECT ts, data FROM events WHERE type = 'system_anomaly' AND json_valid(data) AND (json_extract(data, '$.container') IN (${marks}) OR json_extract(data, '$.agent') IN (${marks})) ORDER BY ts DESC LIMIT ?`)
          .all(...filterNames, ...filterNames, limit)
        : db
          .prepare("SELECT ts, data FROM events WHERE type = 'system_anomaly' ORDER BY ts DESC LIMIT ?")
          .all(limit)) as { ts: number; data: string | null }[];
      const alerts = rows.map((row) => {
        let data: AnomalyData = {};
        try { data = JSON.parse(row.data ?? '{}') as AnomalyData; } catch { /* keep the bare event */ }
        return {
          ts: row.ts,
          metric: typeof data.metric === 'string' ? data.metric : null,
          message: typeof data.message === 'string' ? data.message : 'Anomaly',
          threshold: typeof data.threshold === 'number' ? data.threshold : null,
          container: typeof data.container === 'string' ? data.container : null,
          // Spend alarms (spend.*): what a snooze keys on, and whether this is the "back to normal" note.
          scope: typeof data.scope === 'string' ? data.scope : null,
          agent: typeof data.agent === 'string' ? data.agent : null,
          resolved: data.resolved === true,
          values: Array.isArray(data.values) ? data.values.filter((v): v is number => typeof v === 'number') : [],
        };
      });
      // Display names are resolved now, so rows stored by older versions (container names in the
      // message text) read well too. One cached inspect; the stored rows are never rewritten.
      const candidates = new Set<string>();
      for (const a of alerts) {
        if (a.container) candidates.add(a.container);
        for (const c of containersInText(a.message)) candidates.add(c);
      }
      const names = await getAgentDisplayNames([...candidates]);
      // A spend alarm shows the end of the snooze that silences it, from the server (events.db alert_state).
      const snoozes = activeSnoozes(db);
      const snoozedUntil = (a: { metric: string | null; scope: string | null; agent: string | null; container: string | null }): number | null => {
        if (!a.metric?.startsWith('spend.')) return null;
        const ends = [a.scope, a.agent, a.container].map((k) => (k ? snoozes.get(k) : undefined)).filter((v): v is number => typeof v === 'number');
        return ends.length ? Math.max(...ends) : null;
      };
      return NextResponse.json({
        alerts: alerts.map((a) => {
          const own = a.container ? names.get(a.container) ?? null : null;
          const mentioned = containersInText(a.message);
          return {
            ...a,
            snoozedUntil: snoozedUntil(a),
            agentName: own ?? (mentioned.length === 1 ? names.get(mentioned[0]) ?? null : null),
            displayMessage: nameContainersInText(a.message, names),
          };
        }),
      });
    } finally {
      db.close();
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
