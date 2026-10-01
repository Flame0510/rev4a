'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { formatMb } from '@/lib/utils/format';
import { Skeleton } from '../components/Skeleton';
import { Surface, TimeSeriesChart } from '../components/ui';

const POLL_MS = 30_000;

export interface ContainerHistoryPayload {
  available: boolean;
  range: string;
  bucket_s: number;
  history: { ts: number; cpu_avg: number | null; cpu_max: number | null; mem_avg: number | null; mem_max: number | null }[];
  storage_bucket_s: number;
  storage_history: { ts: number; total_mb: number | null }[];
}

/** A CPU share axis label: an agent sits between 0.01 % and a few percent, so the decimals move with the scale. */
function cpuLabel(v: number): string {
  if (v >= 10) return `${Math.round(v)}%`;
  if (v >= 1) return `${Math.round(v * 10) / 10}%`;
  return `${Math.round(v * 100) / 100}%`;
}

/**
 * The same three charts as the machine's — CPU, Memory, Storage — for one container, under
 * the page's range tabs. Mounted only while its accordion is open: it fetches on mount, polls
 * every 30 s with an `AbortController` ref, and the fetch is aborted when it closes or the
 * range changes. Each series is a small fraction of Docker's cores, so the y axis follows its
 * own peak (`yMax="auto"`) and memory and storage are absolute sizes, not percents.
 */
export function AgentCharts({
  container, range, span, formatTime,
}: { container: string; range: string; span: number; formatTime: (ts: number) => string }) {
  const [data, setData] = useState<ContainerHistoryPayload | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch(
          `/api/metrics/containers?container=${encodeURIComponent(container)}&range=${range}`,
          { signal: controller.signal },
        );
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
        setData(body as ContainerHistoryPayload);
        setError('');
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message || 'Could not load the history');
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [container, range]);

  const to = Math.floor(Date.now() / 1000);
  const from = to - span;
  // While another range loads the previous render stays, dimmed.
  const stale = data !== null && data.range !== range;

  if (error && !data) return <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>;
  if (!data) {
    return (
      <div className="system-agent-charts" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <Surface as="section" variant="subtle" key={i}>
            <div className="ui-kicker"><Skeleton as="span" inline width={110} height={10} /></div>
            <Skeleton height={160} />
            <div className="ui-chart__table"><div style={{ fontSize: 10 }}><Skeleton as="span" inline width={48} height={9} /></div></div>
          </Surface>
        ))}
      </div>
    );
  }

  return (
    <div className="system-agent-charts">
      {error && (
        <p className="ui-muted" style={{ fontSize: 11, margin: 0, gridColumn: '1 / -1' }}>
          Could not refresh ({error}) — showing the last answer; it is tried again every {POLL_MS / 1000} s.
        </p>
      )}
      <Surface as="section" variant="subtle">
        <div className="ui-kicker">CPU · share of Docker's cores</div>
        <TimeSeriesChart
          label={`CPU share of ${container}`}
          points={data.history.map((p) => ({ ts: p.ts, value: p.cpu_avg, peak: p.cpu_max }))}
          from={from}
          to={to}
          bucket={data.bucket_s}
          yMax="auto"
          formatValue={cpuLabel}
          stale={stale}
          formatTime={formatTime}
        />
      </Surface>
      <Surface as="section" variant="subtle">
        <div className="ui-kicker">Memory · average and peak</div>
        <TimeSeriesChart
          label={`Memory of ${container}`}
          points={data.history.map((p) => ({ ts: p.ts, value: p.mem_avg, peak: p.mem_max }))}
          from={from}
          to={to}
          bucket={data.bucket_s}
          yMax="auto"
          formatValue={formatMb}
          stale={stale}
          formatTime={formatTime}
        />
      </Surface>
      <Surface as="section" variant="subtle">
        <div className="ui-kicker">Storage · volumes and writable layer</div>
        <TimeSeriesChart
          label={`Storage of ${container}`}
          points={data.storage_history.map((p) => ({ ts: p.ts, value: p.total_mb }))}
          from={from}
          to={to}
          bucket={data.storage_bucket_s}
          yMax="auto"
          formatValue={formatMb}
          stale={stale}
          formatTime={formatTime}
        />
      </Surface>
    </div>
  );
}
