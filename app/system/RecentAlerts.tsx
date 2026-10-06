'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Pill, Surface } from '../components/ui';
import type { Tone } from '../components/ui/tokens';

const POLL_MS = 60_000;
const LIMIT = 10;

interface Alert { ts: number; metric: string | null; message: string }

/** A disk at its limit is the one that does not clear by itself. Only its own keys, never the prototype's. */
const TONE: Record<string, Tone> = { disk: 'danger', cpu: 'warning', ram: 'warning', container_pids: 'warning', container_memory: 'warning' };
const toneOf = (metric: string): Tone => (Object.hasOwn(TONE, metric) ? TONE[metric] : 'neutral');

/**
 * The latest alarms — the machine's CPU or memory over their threshold on two samples in a row,
 * a disk at 90 %, a container with too many processes or holding most of Docker's memory — which the daemon has always recorded and no page showed, so the red bar
 * on a card never said *what* had crossed or *when*. From `GET /api/metrics/alerts`.
 */
export function RecentAlerts({ timeZone }: { timeZone: string }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch(`/api/metrics/alerts?limit=${LIMIT}`, { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
        setAlerts(body.alerts as Alert[]);
        setError('');
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message || 'Could not load the alerts');
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, []);

  const format = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone });

  return (
    <Surface as="section">
      <div className="ui-kicker">Recent alerts</div>
      <p className="ui-muted" style={{ fontSize: 11, marginTop: 6 }}>
        CPU above 85 % or memory above 90 % on two samples in a row; a disk at 90 %; a container with 1 000 processes on two samples or 90 % of Docker's memory on five. The latest {LIMIT}.
      </p>
      <div style={{ marginTop: 10 }}>
        {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
        {!error && alerts === null && <span className="ui-muted" style={{ fontSize: 12 }}>Loading…</span>}
        {alerts !== null && alerts.length === 0 && <span className="ui-muted" style={{ fontSize: 12 }}>No alert recorded.</span>}
        {alerts?.map((a) => (
          <div className="system-alert" key={`${a.ts}-${a.message}`}>
            <span className="ui-muted">{format.format(new Date(a.ts))}</span>
            <span>{a.metric ? <Pill tone={toneOf(a.metric)}>{a.metric}</Pill> : null}</span>
            <span>{a.message}</span>
          </div>
        ))}
      </div>
    </Surface>
  );
}
