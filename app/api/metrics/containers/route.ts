import os from 'os';
import { NextResponse, type NextRequest } from 'next/server';
import { METRIC_RANGES, openMetricsDb, type MetricRange } from '@/lib/metrics-db';
import { CONTAINER_INTERVAL_S, containerTablesReady, readContainerHistory, readContainerOverview } from '@/lib/container-metrics';
import { CONTAINER_NAME_RE } from '@/lib/docker-stats';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/metrics/containers?range=1h|24h|7d|30d — what every container consumes (CPU,
 * memory, processes, network, disk), now and as an average and peak over the range, plus
 * what is not a container and the disk Docker holds.
 *
 * With `&container=<name>`: that container's history, bucketed like `GET /api/metrics`, for
 * the charts of its accordion on the System page.
 *
 * Read from metrics.db (daemon.js samples every 60 s). `available: false` until the daemon
 * has created the tables.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as NextResponse;

  const params = request.nextUrl.searchParams;
  const param = params.get('range') ?? '1h';
  if (!Object.hasOwn(METRIC_RANGES, param)) {
    return NextResponse.json({ error: `range must be one of ${Object.keys(METRIC_RANGES).join(', ')}` }, { status: 400 });
  }
  const range = param as MetricRange;
  const span = METRIC_RANGES[range];
  const container = params.get('container');
  if (container !== null && !CONTAINER_NAME_RE.test(container)) {
    return NextResponse.json({ error: 'Invalid container name' }, { status: 400 });
  }
  const base = { interval_s: CONTAINER_INTERVAL_S, range };

  try {
    const db = openMetricsDb();
    if (!db) return NextResponse.json({ ...base, available: false });
    try {
      if (!containerTablesReady(db)) return NextResponse.json({ ...base, available: false });
      return NextResponse.json({
        ...base,
        available: true,
        ...(container ? readContainerHistory(db, container, span) : readContainerOverview(db, span, undefined, os.cpus().length)),
      });
    } finally {
      db.close();
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
