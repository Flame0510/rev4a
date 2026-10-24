'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Pill, Surface } from '../components/ui';
import { SnoozeButton, useSnooze } from './SnoozeButton';
import type { Tone } from '../components/ui/tokens';

const POLL_MS = 60_000;
const LIMIT = 10;

interface Alert { ts: number; metric: string | null; message: string; container?: string | null; agentName?: string | null; displayMessage?: string; scope?: string | null; agent?: string | null; resolved?: boolean; snoozedUntil?: number | null }

/** A disk at its limit is the one that does not clear by itself. Only its own keys, never the prototype's. */
const TONE: Record<string, Tone> = { disk: 'danger', cpu: 'warning', ram: 'warning', container_pids: 'warning', container_memory: 'warning', container_oom: 'danger', packages_failed: 'danger', 'spend.context': 'warning', 'spend.loop': 'danger', 'spend.unusual': 'warning', 'spend.unaccounted': 'danger', 'spend.session': 'warning' };
const toneOf = (metric: string): Tone => (Object.hasOwn(TONE, metric) ? TONE[metric] : 'neutral');

/**
 * The latest alarms — the machine's CPU or memory over their threshold on two samples in a row,
 * a disk at 90 %, a container with too many processes or holding most of Docker's memory, one with a process killed for lack of memory (at most one alert per container per 10 minutes, counting the kills in between), or one whose system packages could not be reinstalled — so the red bar
 * on a card says *what* had crossed and *when*. From `GET /api/metrics/alerts`.
 */
export function RecentAlerts({ timeZone }: { timeZone: string }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const loadRef = useRef<() => void>(() => {});
  const snooze = useSnooze(() => loadRef.current());

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
    loadRef.current = load;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, []);

  const format = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });

  return (
    <Surface as="section">
      <div className="ui-kicker">Recent alerts</div>
      <p className="ui-muted" style={{ fontSize: 11, marginTop: 6 }}>
        CPU above 85 % or memory above 90 % on two samples in a row; a disk at 90 %; a container with 1 000 processes on two samples or 90 % of Docker's memory on five; a process killed for lack of memory (with or without a memory limit; at most one alert per container per 10 minutes); system packages an agent could not reinstall after a start; spend and loop alarms (a session that reached its model's whole context window, a day of spend far above the agent's usual day, a failing retry loop, money leaving a provider account that Rev4a did not meter), which can be snoozed for 24 hours. The latest {LIMIT}.
      </p>
      <div style={{ marginTop: 10 }}>
        {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
        {!error && alerts === null && <span className="ui-muted" style={{ fontSize: 12 }}>Loading…</span>}
        {alerts !== null && alerts.length === 0 && <span className="ui-muted" style={{ fontSize: 12 }}>No alert recorded.</span>}
        {alerts?.map((a) => (
          <div className="system-alert" key={`${a.ts}-${a.message}`}>
            <span className="ui-muted">{format.format(new Date(a.ts))}</span>
            <span>{a.metric ? <Pill tone={toneOf(a.metric)}>{a.metric}</Pill> : null}</span>
            <span>{a.displayMessage ?? a.message}{a.container && !(a.displayMessage ?? a.message).includes(a.container) ? <span className="ui-muted" style={{ marginLeft: 6, fontSize: 11 }}>{a.agentName && !(a.displayMessage ?? a.message).includes(a.agentName) ? `${a.agentName} · ` : ''}{a.container}</span> : null}</span>
            {a.metric?.startsWith('spend.') && !a.resolved && (a.agent ?? a.scope) ? <span><SnoozeButton target={(a.agent ?? a.scope) as string} snoozedUntil={a.snoozedUntil} running={snooze.running} onSnooze={(t) => { void snooze.run(t); }} timeZone={timeZone} /></span> : null}
          </div>
        ))}
      </div>
    </Surface>
  );
}
