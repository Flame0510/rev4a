'use client';

/**
 * Resources section of the agent detail panel: what this agent's container consumes now and
 * over the last 24 h (GET /api/metrics/containers, from metrics.db). The history charts are
 * on the System page — one place, linked from here.
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { formatMb, formatRate, formatSharePercent } from '@/lib/utils/format';
import { PanelRow } from './PanelRow';

interface Overview {
  available: boolean;
  interval_s: number;
  age_s?: number | null;
  containers?: {
    container: string;
    running: boolean;
    now: { cpu_cores: number | null; cpu_percent: number | null; mem_mb: number | null; mem_percent: number | null; pids: number | null; net_rx_bps: number | null; net_tx_bps: number | null } | null;
    range: { cpu_avg_percent: number | null; cpu_max_percent: number | null; mem_avg_mb: number | null; mem_max_mb: number | null };
    storage: { volume_mb: number | null; layer_mb: number | null; total_mb: number | null };
  }[];
}

const note = (text: string) => <div style={{ padding: '12px 14px', fontSize: 12, color: '#888' }}>{text}</div>;

export default function ResourceSection({ container }: { container: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch('/api/metrics/containers?range=24h', { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
        setData(body as Overview);
        setError('');
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message || 'Could not load the resources');
      }
    };
    setData(null);
    setError('');
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [container]);

  if (error && !data) return <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--red)' }}>{error}</div>;
  if (!data) return note('Loading…');
  if (!data.available) return note(`No samples yet: the Rev4a daemon samples the containers every ${data.interval_s} s.`);

  const row = data.containers?.find((c) => c.container === container);
  if (!row) return note('Not sampled in the last 24 h: the agent was not running.');
  // The same three-intervals rule as the System page: a daemon that stopped must not present
  // hours-old figures as "now".
  const stale = data.age_s != null && data.age_s > data.interval_s * 3;
  const r = row.range;
  const n = row.now;

  return (
    <div>
      {error && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--yellow)', borderBottom: '1px solid var(--border)' }}>
          Could not refresh ({error}): showing the last answer.
        </div>
      )}
      {stale ? (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--yellow)', borderBottom: '1px solid var(--border)' }}>
          Not collecting: the latest sample is {Math.round((data.age_s ?? 0) / 60)} min old. Check that the Rev4a daemon is running; the figures below are from when it last answered.
        </div>
      ) : row.running && n ? (
        <>
          <PanelRow label="CPU now" value={`${formatSharePercent(n.cpu_percent)} of Docker's cores${n.cpu_cores !== null ? ` · ${n.cpu_cores.toFixed(3)} cores` : ''}`} />
          <PanelRow label="Memory now" value={`${formatMb(n.mem_mb)}${n.mem_percent !== null ? ` · ${n.mem_percent}% of Docker's memory` : ''}`} />
          <PanelRow label="Processes" value={String(n.pids ?? '—')} />
          <PanelRow label="Network" value={`↓ ${formatRate(n.net_rx_bps)} ↑ ${formatRate(n.net_tx_bps)}`} />
        </>
      ) : (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--yellow)', borderBottom: '1px solid var(--border)' }}>
          Stopped: the figures below are from when it last ran.
        </div>
      )}
      <PanelRow label="CPU · last 24 h" value={`avg ${formatSharePercent(r.cpu_avg_percent)} · peak ${formatSharePercent(r.cpu_max_percent)}`} />
      <PanelRow label="Memory · last 24 h" value={`avg ${formatMb(r.mem_avg_mb)} · peak ${formatMb(r.mem_max_mb)}`} />
      <PanelRow
        label="Storage"
        value={`${formatMb(row.storage.total_mb)}${row.storage.volume_mb !== null ? ` · volume ${formatMb(row.storage.volume_mb)}` : ''}${row.storage.layer_mb !== null ? ` · layer ${formatMb(row.storage.layer_mb)}` : ''}`}
      />
      <div style={{ padding: '8px 14px', fontSize: 11 }}>
        <Link href={`/system?agent=${encodeURIComponent(container)}`} className="ui-link">Charts on the System page →</Link>
      </div>
    </div>
  );
}
