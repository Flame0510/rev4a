'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { SnoozeButton, useSnooze } from './SnoozeButton';

const POLL_MS = 60_000;
const DAY_MS = 24 * 3600 * 1000;

interface Alert { ts: number; metric: string | null; message: string; displayMessage?: string; scope?: string | null; agent?: string | null; resolved?: boolean; snoozedUntil?: number | null }

/**
 * The agent panel's note for a spend or loop alarm (metric `spend.*`) raised in the last 24 hours
 * and not yet resolved, with a Snooze button. Renders nothing when there is none.
 * From `GET /api/metrics/alerts?container=<name>&agent=<id>`.
 */
export function AgentSpendAlerts({ container, agentId }: { container: string; agentId?: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const loadRef = useRef<() => void>(() => {});
  const snooze = useSnooze(() => loadRef.current());

  useEffect(() => {
    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch(`/api/metrics/alerts?limit=20&container=${encodeURIComponent(container)}${agentId ? `&agent=${encodeURIComponent(agentId)}` : ''}`, { signal: controller.signal });
        if (!res.ok) return;
        const all = ((await res.json())?.alerts ?? []) as Alert[];
        // Newest first. A resolved note closes the earlier alarm of the same metric.
        const closed = new Set<string>();
        const open: Alert[] = [];
        for (const a of all) {
          if (!a.metric?.startsWith('spend.') || Date.now() - a.ts > DAY_MS) continue;
          const key = `${a.metric}|${a.scope ?? ''}`;
          if (a.resolved) closed.add(key);
          else if (!closed.has(key)) open.push(a);
        }
        setAlerts(open);
      } catch { /* a missing note is not worth an error line */ }
    };
    setAlerts([]);
    loadRef.current = () => { void load(); };
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [container, agentId]);

  if (!alerts.length) return null;
  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      {alerts.map((a, i) => (
        <div key={`${a.ts}-${a.metric}-${a.agent ?? a.scope}-${i}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 14px', fontSize: 11 }}>
          <span style={{ color: 'var(--yellow)' }}>{a.displayMessage ?? a.message}</span>
          {(a.agent ?? a.scope) ? <SnoozeButton target={(a.agent ?? a.scope) as string} snoozedUntil={a.snoozedUntil} running={snooze.running} onSnooze={(t) => { void snooze.run(t); }} /> : null}
        </div>
      ))}
    </div>
  );
}
