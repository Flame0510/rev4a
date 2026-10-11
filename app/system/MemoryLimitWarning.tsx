'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Surface } from '../components/ui';

const POLL_MS = 60_000;
/** The running containers' memory, as a share of Docker's total memory, from which agents without a limit are called out. */
const WARN_PERCENT = 85;

interface Row {
  container: string;
  name: string;
  agent_id: string | null;
  is_agent: boolean;
  running: boolean;
  now: { mem_mb: number | null } | null;
}

interface Overview {
  available: boolean;
  interval_s: number;
  age_s?: number | null;
  host?: { mem_total_mb: number } | null;
  containers?: Row[];
}

interface Warning {
  percent: number;
  /** Agents with no limit, or whose limit could not be read (counted as unknown). */
  unlimited: { agentId: string; label: string }[];
}

/**
 * Shown only when the running containers' memory is at 85 % or more of Docker's total memory
 * on the latest sample and at least one running agent has no memory limit or its limit could
 * not be read: one agent can then starve the others.
 * Renders nothing otherwise (and while the answer is unknown), so a healthy machine never
 * sees it. The limit of each running agent is read only when the memory is high.
 */
export function MemoryLimitWarning() {
  const [warning, setWarning] = useState<Warning | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch('/api/metrics/containers?range=1h', { signal: controller.signal });
        const body = (await res.json()) as Overview;
        const total = body.host?.mem_total_mb;
        // A daemon that stopped must not keep an old alarm on screen: same three-intervals rule as the cards.
        const stale = body.age_s != null && body.age_s > body.interval_s * 3;
        if (!res.ok || !body.available || stale || !total || total <= 0) { setWarning(null); return; }
        const rows = body.containers ?? [];
        const used = rows.reduce((sum, r) => sum + (r.running && r.now?.mem_mb ? r.now.mem_mb : 0), 0);
        // Compared unrounded: 84.5 % is below the threshold; rounding is for display only.
        const ratio = used / total;
        if (ratio * 100 < WARN_PERCENT) { setWarning(null); return; }
        const percent = Math.round(ratio * 100);

        const agents = rows.filter((r) => r.is_agent && r.running && r.agent_id);
        const limits = await Promise.all(agents.map(async (r) => {
          try {
            const lr = await apiFetch(`/api/agents/${encodeURIComponent(r.agent_id as string)}/memory-limit`, { signal: controller.signal });
            if (!lr.ok) return { row: r, limitMb: null };
            return { row: r, limitMb: ((await lr.json()) as { limitMb: number | null }).limitMb };
          } catch (e: any) {
            if (e?.name === 'AbortError') throw e;
            return { row: r, limitMb: null }; // unreadable: counted as "limit unknown"
          }
        }));
        const unlimited = limits
          .filter((l) => l.limitMb === null)
          .map((l) => ({ agentId: l.row.agent_id as string, label: l.row.name || l.row.container }));
        setWarning(unlimited.length > 0 ? { percent, unlimited } : null);
      } catch (e: any) {
        if (e?.name !== 'AbortError') setWarning(null);
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, []);

  if (!warning) return null;
  const n = warning.unlimited.length;
  return (
    <Surface as="section" tone="warning">
      <div className="ui-kicker">Memory limit</div>
      <p style={{ fontSize: 12, marginTop: 6 }}>
        Running containers use {warning.percent} % of Docker's memory. {n} running {n === 1 ? 'agent has' : 'agents have'} no memory limit or could not be read: one agent can starve the others.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8, fontSize: 12 }}>
        {warning.unlimited.map((a) => (
          <Link key={a.agentId} href={`/agents?agent=${encodeURIComponent(a.agentId)}`} className="ui-link">{a.label}</Link>
        ))}
      </div>
    </Surface>
  );
}
