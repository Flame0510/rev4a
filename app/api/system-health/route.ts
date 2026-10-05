import { NextResponse, type NextRequest } from 'next/server';
import { openDb } from '@/lib/db';
import { latestMetricSample } from '@/lib/metrics-db';
import { maybeSendAlert } from '@/lib/alerts';
import { dashboardCosts } from '@/lib/agent-costs';
import { listOpenClawCronJobs } from '@/lib/openclaw-cron';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { countFailureEvents } from '@/lib/runtime-errors';

export const dynamic = 'force-dynamic';

/** A day above this (US dollars, UTC day) raises the cost check to a warning. */
const HIGH_DAILY_SPEND_USD = 10;

type Health = 'ok' | 'warning' | 'error';
type Severity = 'info' | 'warning' | 'critical';

interface SystemCheck {
  id: string;
  label: string;
  health: Health;
  value: string | number;
  details?: string;
  source: 'runtime' | 'cron' | 'cost' | 'trello';
}

interface Recommendation {
  id: string;
  severity: Severity;
  source: SystemCheck['source'];
  title: string;
  details: string;
  actionHref?: string;
  dismissible: boolean;
  createdAt: string;
  trelloCardId?: string;
}

function topHealth(values: Health[]): Health {
  if (values.includes('error')) return 'error';
  if (values.includes('warning')) return 'warning';
  return 'ok';
}

function getSeconds(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 10_000_000_000 ? Math.floor(n / 1000) : n;
}

function getEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;

  const now = new Date();
  const createdAt = now.toISOString();
  const checks: SystemCheck[] = [];
  const recommendations: Recommendation[] = [];

  try {
    const db = openDb();
    const sessionCount = (db.prepare('SELECT COUNT(*) AS total FROM sessions').get() as { total: number }).total;
    const latestSessionRow = db.prepare('SELECT MAX(COALESCE(updated_at, started_at, 0)) AS latest FROM sessions').get() as { latest: number | null };
    const latestSessionTs = getSeconds(latestSessionRow.latest);
    const latestSessionAgeSeconds = latestSessionTs ? Math.floor(Date.now() / 1000) - latestSessionTs : null;
    const staleThresholdSeconds = getEnvNumber('REV4A_ALERT_STALE_SECONDS', 120);

    checks.push({
      id: 'runtime.sessions',
      label: 'Runtime sessions',
      health: 'ok',
      value: sessionCount,
      details: latestSessionAgeSeconds === null ? 'No session detected' : `last session activity ${Math.round(latestSessionAgeSeconds / 60)}m ago`,
      source: 'runtime',
    });

    // The daemon's heartbeat: the age of its newest machine metrics sample (metrics.db, every
    // 30 s on a timer of its own). It proves the daemon is alive — not that the OpenClaw session
    // poll is ingesting, which runs separately and may have nothing to poll on this host.
    const metricSample = latestMetricSample();
    const hasSystemMetrics = metricSample.available;
    const latestMetricTs = getSeconds(metricSample.ts);
    const latestMetricAgeSeconds = latestMetricTs ? Math.floor(Date.now() / 1000) - latestMetricTs : null;
    const runtimeFreshnessHealth: Health = !hasSystemMetrics
      ? 'ok'
      : latestMetricAgeSeconds === null
        ? 'warning'
        : latestMetricAgeSeconds > staleThresholdSeconds
          ? 'warning'
          : 'ok';

    checks.push({
      id: 'runtime.heartbeat',
      label: 'Daemon heartbeat',
      health: runtimeFreshnessHealth,
      value: hasSystemMetrics ? (latestMetricTs ? 'fresh' : 'missing') : 'n/d',
      details: metricSample.error
        ? `metrics.db unreadable: ${metricSample.error}`
        : !hasSystemMetrics
          ? 'No machine metrics database yet'
          : latestMetricAgeSeconds === null
            ? 'No machine metrics sample yet'
            : `last machine metrics sample ${latestMetricAgeSeconds}s ago`,
      source: 'runtime',
    });

    if (hasSystemMetrics && runtimeFreshnessHealth !== 'ok') {
      recommendations.push({
        id: 'runtime.check-freshness',
        severity: 'warning',
        source: 'runtime',
        title: 'Check that the Rev4a daemon is running',
        details: latestMetricAgeSeconds === null
          ? 'No machine metrics sample yet.'
          : `No machine metrics sample for ${latestMetricAgeSeconds}s (threshold ${staleThresholdSeconds}s).`,
        actionHref: '/system',
        dismissible: false,
        createdAt,
      });
    }

    await maybeSendAlert({
      key: 'system-health.db-freshness',
      kind: 'db-freshness',
      title: 'Rev4a DB freshness',
      message: !hasSystemMetrics
        ? 'No machine metrics database: the daemon heartbeat cannot be verified.'
        : latestMetricAgeSeconds === null
          ? 'No machine metrics sample yet.'
          : `Last machine metrics sample ${latestMetricAgeSeconds}s ago (threshold ${staleThresholdSeconds}s).`,
      resolvedMessage: 'Rev4a daemon sampling again.',
      stale: hasSystemMetrics ? (latestMetricAgeSeconds === null ? true : latestMetricAgeSeconds > staleThresholdSeconds) : false,
    });

    const eventErrorCount = countFailureEvents(db, Date.now() - 86_400_000);
    checks.push({
      id: 'runtime.errors24h',
      label: 'Failed runs (24h)',
      health: eventErrorCount > 0 ? 'warning' : 'ok',
      value: eventErrorCount,
      source: 'runtime',
    });
    if (eventErrorCount > 0) {
      recommendations.push({
        id: 'runtime.review-errors',
        severity: 'warning',
        source: 'runtime',
        title: 'Review recent errors',
        details: `${eventErrorCount} failed or timed-out runs in the last 24h.`,
        actionHref: '/lineage',
        dismissible: true,
        createdAt,
      });
    }

    db.close();
  } catch (error) {
    checks.push({ id: 'runtime.db', label: 'Rev4a DB', health: 'error', value: 'error', details: (error as Error).message, source: 'runtime' });
    recommendations.push({ id: 'runtime.db-error', severity: 'critical', source: 'runtime', title: 'Rev4a DB unreadable', details: (error as Error).message, dismissible: false, createdAt });
  }

  // What the agents spent today (UTC day), as their own OpenClaw priced it (costs.db).
  const spend = dashboardCosts();
  if (spend?.error) {
    checks.push({ id: 'cost.usageBasedToday', label: 'Spent today', health: 'warning', value: 'error', details: `costs.db unreadable: ${spend.error}`, source: 'cost' });
  } else {
    const today = spend?.today ?? 0;
    const missing = spend?.missingToday ?? 0;
    checks.push({
      id: 'cost.usageBasedToday',
      label: 'Spent today',
      health: today > HIGH_DAILY_SPEND_USD || missing > 0 ? 'warning' : 'ok',
      value: `$${today.toFixed(2)}`,
      details: spend
        ? `Priced by the agents' OpenClaw, UTC day${missing ? `; ${missing} call(s) without a price` : ''}`
        : 'No figures yet: the daemon reads the agents every 5 min',
      source: 'cost',
    });
    if (today > HIGH_DAILY_SPEND_USD) {
      recommendations.push({
        id: 'cost.review-usage-based',
        severity: 'warning',
        source: 'cost',
        title: 'High spend today',
        details: `The agents have spent $${today.toFixed(2)} today (UTC).`,
        actionHref: '/costs',
        dismissible: true,
        createdAt,
      });
    }
    if (missing > 0) {
      recommendations.push({
        id: 'cost.unpriced-calls',
        severity: 'warning',
        source: 'cost',
        title: 'Calls without a price',
        details: `${missing} model call(s) today could not be priced: their model has no price in Rev4a, or a dynamic one (OpenRouter Auto).`,
        actionHref: '/costs',
        dismissible: true,
        createdAt,
      });
    }
  }

  try {
    const cron = await listOpenClawCronJobs();
    const enabled = cron.jobs.filter((job) => job.enabled !== false).length;
    const hostCount = cron.jobs.filter((j) => j.source === 'host').length;
    const containerCount = cron.jobs.filter((j) => j.source === 'container').length;
    checks.push({ id: 'cron.jobs', label: 'Cron jobs', health: enabled > 0 ? 'ok' : 'warning', value: enabled, details: `${hostCount} host · ${containerCount} container`, source: 'cron' });
    if (enabled === 0) {
      recommendations.push({ id: 'cron.enable-watchdog', severity: 'warning', source: 'cron', title: 'No enabled cron detected', details: 'No cron jobs are enabled on the host or any agent container.', actionHref: '/crons', dismissible: false, createdAt });
    }
  } catch (error) {
    checks.push({ id: 'cron.openclaw', label: 'Cron jobs', health: 'warning', value: 'warning', details: (error as Error).message, source: 'cron' });
    recommendations.push({ id: 'cron.openclaw-unavailable', severity: 'warning', source: 'cron', title: 'Cron list unavailable', details: 'Failed to list cron jobs.', actionHref: '/crons', dismissible: false, createdAt });
  }

  const health = topHealth(checks.map((check) => check.health));
  return NextResponse.json({ health, checks, recommendations, generatedAt: createdAt });
}
