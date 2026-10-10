import { NextResponse, type NextRequest } from 'next/server';
import { openDb } from '@/lib/db';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface AnomalyData { metric?: unknown; message?: unknown; threshold?: unknown; values?: unknown; container?: unknown }

/**
 * GET /api/metrics/alerts?limit=10 — the latest `system_anomaly` events (the machine's CPU, RAM
 * or a disk over its threshold, and a container's process count or sustained memory; written
 * by daemon.js into events.db), newest first. A `container_oom` event (a process in an agent
 * container killed for lack of memory) also carries `container`, the container's name.
 * Optional `container=<name>` keeps only the events of that container (the events written
 * with a `container` field; the machine-wide ones carry none). Other params are ignored. Nothing else in `events`: the generic
 * /api/events has no type filter.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as NextResponse;

  const container = request.nextUrl.searchParams.get('container');
  const parsed = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  try {
    const db = openDb();
    try {
      // The container filter runs on the stored JSON, so it is applied in SQL by name
      // (json_extract, the name is a bound parameter) and the limit counts matches only.
      const rows = (container
        ? db
          .prepare("SELECT ts, data FROM events WHERE type = 'system_anomaly' AND json_valid(data) AND json_extract(data, '$.container') = ? ORDER BY ts DESC LIMIT ?")
          .all(container, limit)
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
          values: Array.isArray(data.values) ? data.values.filter((v): v is number => typeof v === 'number') : [],
        };
      });
      return NextResponse.json({ alerts });
    } finally {
      db.close();
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
