'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { useRev4aTimezone } from '@/lib/hooks/useRev4aTimezone';
import { formatMb } from '@/lib/utils/format';
import { Meter, meterLevel, Page, PageHeader, Pill, Surface, Tabs, TimeSeriesChart } from '../components/ui';
import { AgentsSection } from './AgentsSection';
import { MemoryLimitWarning } from './MemoryLimitWarning';
import { OrphanVolumes } from './OrphanVolumes';
import { RecentAlerts } from './RecentAlerts';
import { SystemCardsSkeleton, SystemChartsSkeleton, SystemDescription } from './SystemSkeleton';

type Range = '1h' | '24h' | '7d' | '30d';
const RANGES: { id: Range; label: string; span: number }[] = [
  { id: '1h', label: '1h', span: 3600 },
  { id: '24h', label: '24h', span: 86_400 },
  { id: '7d', label: '7d', span: 7 * 86_400 },
  { id: '30d', label: '30d', span: 30 * 86_400 },
];
const POLL_MS = 30_000;

/** Thresholds (%) for the meters: warning, critical. */
const CPU_RAM_LEVELS = [85, 95] as const;
const DISK_LEVELS = [80, 90] as const;

interface Disk {
  mount: string;
  roles: string[];
  used_mb: number;
  avail_mb: number;
  total_mb: number;
  percent: number;
}

interface MetricsPayload {
  latest: {
    ts: number;
    age_s: number;
    cpu: number | null;
    ram_used_mb: number | null;
    ram_total_mb: number | null;
    swap_used_mb: number | null;
    swap_total_mb: number | null;
    load_avg_1m: number | null;
    load_avg_5m: number | null;
    load_avg_15m: number | null;
    disks: Disk[];
  } | null;
  host: { hostname: string; platform: string; cores: number; uptime_s: number };
  interval_s: number;
  range: Range;
  bucket_s: number;
  history: { ts: number; cpu_avg: number | null; cpu_max: number | null; ram_avg: number | null; ram_max: number | null }[];
  disk_history: { mount: string; points: { ts: number; percent: number | null }[] }[];
}

const ROLE_LABEL: Record<string, string> = { root: 'system', docker: 'Docker data', data: 'Rev4a data' };
/** A filesystem's display name: the bare "/" is the root volume — clearer as a word. Its mount stays in the aria-label and, for other filesystems, is the name. */
const diskLabel = (mount: string) => (mount === '/' ? 'Root' : mount);

function formatUptime(s: number): string {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function percentOf(used: number | null, total: number | null): number | null {
  return used !== null && total ? Math.round((used / total) * 1000) / 10 : null;
}

function timeFormatter(range: Range, timeZone: string): (ts: number) => string {
  const opts: Intl.DateTimeFormatOptions =
    range === '1h' || range === '24h'
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const fmt = new Intl.DateTimeFormat(undefined, { ...opts, timeZone });
  return (ts) => fmt.format(new Date(ts * 1000));
}

export default function SystemPageClient() {
  const [range, setRange] = useState<Range>('1h');
  const [data, setData] = useState<MetricsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (r: Range) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/metrics?range=${r}`, { signal: controller.signal });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      setData(body as MetricsPayload);
      setError('');
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setError(e?.message || 'Could not load the metrics');
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
    const timer = setInterval(() => load(range), POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [range, load]);

  const latest = data?.latest ?? null;
  const host = data?.host;
  const span = RANGES.find((r) => r.id === range)!.span;
  const to = Math.floor(Date.now() / 1000);
  const from = to - span;
  const timeZone = useRev4aTimezone();
  const formatTime = timeFormatter(range, timeZone);
  const stale = latest !== null && data !== null && latest.age_s > data.interval_s * 3;
  const chartStale = loading && data !== null && data.range !== range;
  // Before the first answer: placeholders shaped like the content (an error shows instead).
  const firstLoad = data === null && !error;

  const cpu = latest?.cpu ?? null;
  const ramPct = latest ? percentOf(latest.ram_used_mb, latest.ram_total_mb) : null;

  return (
    <Page>
      <PageHeader
        eyebrow="Host"
        title="System"
        description={<SystemDescription host={host ? `${host.hostname} · ${host.cores} cores · up ${formatUptime(host.uptime_s)}` : null} />}
      />

      {error && <Surface tone="danger"><span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span></Surface>}

      {data && !latest && (
        <Surface tone="warning">
          <div className="ui-kicker">No samples yet</div>
          <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
            The Rev4a daemon records one every {data.interval_s} s. If this stays empty, check that `rev4a serve` is running.
          </p>
        </Surface>
      )}

      {stale && latest && (
        <Surface tone="warning">
          <div className="ui-kicker">Not collecting</div>
          <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
            The latest sample is {formatUptime(latest.age_s)} old: the values below are not current. Check that the Rev4a daemon is running.
          </p>
        </Surface>
      )}

      {firstLoad ? <SystemCardsSkeleton /> : (
      <div className="system-cards">
        <Surface as="article">
          <div className="ui-kicker">CPU</div>
          <div className="ui-metric-value">{cpu !== null ? `${Math.round(cpu)}%` : '—'}</div>
          {cpu !== null && <Meter percent={cpu} level={meterLevel(cpu, ...CPU_RAM_LEVELS)} label="CPU in use" />}
          <div className="ui-key-values" style={{ marginTop: 12 }}>
            <div className="ui-key-value"><span className="ui-muted">Cores</span><span>{host?.cores ?? '—'}</span></div>
            <div className="ui-key-value">
              <span className="ui-muted">Load 1 / 5 / 15 min</span>
              <span>{latest ? `${latest.load_avg_1m ?? '—'} / ${latest.load_avg_5m ?? '—'} / ${latest.load_avg_15m ?? '—'}` : '—'}</span>
            </div>
          </div>
        </Surface>

        <Surface as="article">
          <div className="ui-kicker">Memory</div>
          <div className="ui-metric-value">{ramPct !== null ? `${Math.round(ramPct)}%` : '—'}</div>
          {ramPct !== null && <Meter percent={ramPct} level={meterLevel(ramPct, ...CPU_RAM_LEVELS)} label="Memory in use" />}
          <div className="ui-key-values" style={{ marginTop: 12 }}>
            <div className="ui-key-value">
              <span className="ui-muted">Used / total</span>
              <span>{latest ? `${formatMb(latest.ram_used_mb)} / ${formatMb(latest.ram_total_mb)}` : '—'}</span>
            </div>
            <div className="ui-key-value">
              <span className="ui-muted">Available</span>
              <span>{latest && latest.ram_total_mb !== null && latest.ram_used_mb !== null ? formatMb(latest.ram_total_mb - latest.ram_used_mb) : '—'}</span>
            </div>
            <div className="ui-key-value">
              <span className="ui-muted">Swap used / total</span>
              <span>{latest && latest.swap_total_mb ? `${formatMb(latest.swap_used_mb)} / ${formatMb(latest.swap_total_mb)}` : 'none'}</span>
            </div>
          </div>
        </Surface>

        <Surface as="article">
          <div className="ui-kicker">Storage</div>
          {!latest?.disks.length && <div className="ui-metric-value">—</div>}
          {latest?.disks.map((d) => (
            <div key={d.mount} style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13 }}>{diskLabel(d.mount)}</span>
                <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {d.roles.map((r) => <Pill key={r}>{ROLE_LABEL[r] ?? r}</Pill>)}
                </span>
              </div>
              <Meter percent={d.percent} level={meterLevel(d.percent, ...DISK_LEVELS)} label={`Storage in use on ${d.mount}`} />
              <div className="ui-key-value" style={{ marginTop: 6 }}>
                <span className="ui-muted">{d.percent}% · {formatMb(d.used_mb)} of {formatMb(d.total_mb)}</span>
                <span>{formatMb(d.avail_mb)} free</span>
              </div>
            </div>
          ))}
        </Surface>
      </div>
      )}

      <Tabs items={RANGES.map((r) => ({ label: r.label, active: range === r.id, onClick: () => setRange(r.id) }))} />

      {firstLoad ? <SystemChartsSkeleton /> : (
      <div className="system-charts">
        <Surface as="section">
          <div className="ui-kicker">CPU · average and peak</div>
          <TimeSeriesChart
            label="CPU in use"
            points={(data?.history ?? []).map((p) => ({ ts: p.ts, value: p.cpu_avg, peak: p.cpu_max }))}
            from={from}
            to={to}
            bucket={data?.bucket_s ?? 30}
            stale={chartStale}
            formatTime={formatTime}
          />
        </Surface>
        <Surface as="section">
          <div className="ui-kicker">Memory · average and peak</div>
          <TimeSeriesChart
            label="Memory in use"
            points={(data?.history ?? []).map((p) => ({ ts: p.ts, value: p.ram_avg, peak: p.ram_max }))}
            from={from}
            to={to}
            bucket={data?.bucket_s ?? 30}
            stale={chartStale}
            formatTime={formatTime}
          />
        </Surface>
        {(data?.disk_history ?? []).map((d) => (
          <Surface as="section" key={d.mount}>
            <div className="ui-kicker">Storage · {diskLabel(d.mount)}</div>
            <TimeSeriesChart
              label={`Storage in use on ${d.mount}`}
              points={d.points.map((p) => ({ ts: p.ts, value: p.percent }))}
              from={from}
              to={to}
              bucket={data?.bucket_s ?? 30}
              stale={chartStale}
              formatTime={formatTime}
            />
          </Surface>
        ))}
      </div>
      )}

      <MemoryLimitWarning />

      <AgentsSection range={range} span={span} formatTime={formatTime} />

      <OrphanVolumes timeZone={timeZone} />

      <RecentAlerts timeZone={timeZone} />
    </Page>
  );
}
