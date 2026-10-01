import os from 'os';
import { NextResponse, type NextRequest } from 'next/server';
import { METRIC_RANGES as RANGES, openMetricsDb, type MetricRange as Range } from '@/lib/metrics-db';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/** How often daemon.js samples the machine; the page calls a sample older than 3× this stale. */
const SAMPLE_INTERVAL_S = 30;

/**
 * History ranges are in lib/metrics-db.ts; each is cut into about POINTS buckets, never
 * shorter than two samples — a 30 s bucket on a 30 s timer that drifts a second would leave
 * empty buckets, drawn as gaps, where no sample is missing.
 */
const POINTS = 120;

interface LatestRow {
  ts: number;
  cpu: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
  swap_used_mb: number | null;
  swap_total_mb: number | null;
  load_avg_1m: number | null;
  load_avg_5m: number | null;
  load_avg_15m: number | null;
}

interface DiskRow {
  mount: string;
  roles: string | null;
  used_mb: number;
  avail_mb: number;
  total_mb: number;
}

/** Share of a filesystem in use, as `df` computes it: used / (used + avail). */
function diskPercent(used: number, avail: number): number {
  return used + avail > 0 ? Math.round((used / (used + avail)) * 100) : 0;
}

/**
 * Machine metrics of the host Rev4a runs on: the latest sample, live host facts, and a
 * bucketed history for one range (average and peak per bucket).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const param = new URL(request.url).searchParams.get('range') ?? '1h';
  if (!Object.hasOwn(RANGES, param)) {
    return NextResponse.json({ error: `range must be one of ${Object.keys(RANGES).join(', ')}` }, { status: 400 });
  }
  const range = param as Range;
  const span = RANGES[range];
  const bucket = Math.max(2 * SAMPLE_INTERVAL_S, Math.round(span / POINTS));
  const now = Math.floor(Date.now() / 1000);
  const since = now - span;

  const host = {
    hostname: os.hostname(),
    platform: os.platform(),
    cores: os.cpus().length,
    uptime_s: Math.round(os.uptime()),
  };
  const base = { host, interval_s: SAMPLE_INTERVAL_S, range, bucket_s: bucket };

  try {
    const db = openMetricsDb();
    // No metrics database yet: the daemon has not sampled once.
    if (!db) return NextResponse.json({ ...base, latest: null, history: [], disk_history: [] });
    try {
      const latest = db
        .prepare(
          `SELECT ts, cpu_percent AS cpu, ram_used_mb, ram_total_mb, swap_used_mb, swap_total_mb,
             load_avg_1m, load_avg_5m, load_avg_15m
           FROM system_metrics ORDER BY ts DESC LIMIT 1`,
        )
        .get() as LatestRow | undefined;

      const disks = latest
        ? (db
            // One row per mount even if two samples share this ts (a second daemon, a clock step).
            .prepare('SELECT mount, roles, used_mb, avail_mb, total_mb FROM system_disks WHERE ts = ? GROUP BY mount ORDER BY mount')
            .all(latest.ts) as DiskRow[])
        : [];

      const history = db
        .prepare(
          `SELECT (ts / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) AS ts,
             ROUND(AVG(cpu_percent), 1) AS cpu_avg,
             ROUND(MAX(cpu_percent), 1) AS cpu_max,
             ROUND(AVG(ram_used_mb * 100.0 / NULLIF(ram_total_mb, 0)), 1) AS ram_avg,
             ROUND(MAX(ram_used_mb * 100.0 / NULLIF(ram_total_mb, 0)), 1) AS ram_max
           FROM system_metrics WHERE ts > @since
           GROUP BY ts / CAST(@bucket AS INTEGER) ORDER BY ts`,
        )
        .all({ bucket, since });

      const diskRows = db
        .prepare(
          `SELECT mount, (ts / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) AS ts,
             ROUND(AVG(used_mb * 100.0 / NULLIF(used_mb + avail_mb, 0)), 1) AS percent
           FROM system_disks WHERE ts > @since
           GROUP BY mount, ts / CAST(@bucket AS INTEGER) ORDER BY mount, ts`,
        )
        .all({ bucket, since }) as { mount: string; ts: number; percent: number | null }[];
      const diskHistory = new Map<string, { ts: number; percent: number | null }[]>();
      for (const r of diskRows) {
        const points = diskHistory.get(r.mount) ?? [];
        points.push({ ts: r.ts, percent: r.percent });
        diskHistory.set(r.mount, points);
      }

      return NextResponse.json({
        latest: latest
          ? {
              ...latest,
              age_s: Math.max(0, now - latest.ts),
              disks: disks.map((d) => ({
                ...d,
                roles: d.roles ? d.roles.split(',') : [],
                percent: diskPercent(d.used_mb, d.avail_mb),
              })),
            }
          : null,
        ...base,
        history,
        disk_history: [...diskHistory].map(([mount, points]) => ({ mount, points })),
      });
    } finally {
      db.close();
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
