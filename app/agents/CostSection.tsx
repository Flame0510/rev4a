'use client';

/**
 * Costs section of the agent detail panel: what this agent spent, as its own OpenClaw
 * priced it (GET /api/costs/agent, from costs.db). The Costs page has the whole fleet.
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { formatCost, formatTokens } from '@/lib/utils/format';
import { PanelRow } from './PanelRow';

interface AgentCosts {
  available: boolean;
  intervalS: number;
  /** The vendor band billed right now (DeepSeek peak / off-peak), when one of its models is on offer. */
  pricing?: { vendor: string; band: 'peak' | 'off-peak'; nextChange: number | null; source: string } | null;
  today?: number;
  week?: number;
  month?: number;
  tokensMonth?: number;
  topModel?: { model: string; cost: number } | null;
  unpricedMonth?: number;
  /** ChatGPT subscription usage over 30 days, covered by the plan (not in the figures above). */
  subscription?: { tokens: number; calls: number; apiValue: number; unpricedCalls: number } | null;
  collectedAt?: number | null;
  error?: string | null;
}


function formatAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export default function CostSection({ container }: { container: string }) {
  const [data, setData] = useState<AgentCosts | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch(`/api/costs/agent?container=${encodeURIComponent(container)}`, { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
        setData(body as AgentCosts);
        setError('');
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message || 'Could not load the costs');
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

  if (error) return <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--red)' }}>{error}</div>;
  if (!data) return <div style={{ padding: '12px 14px', fontSize: 12, color: '#888' }}>Loading…</div>;
  if (!data.available) {
    return <div style={{ padding: '12px 14px', fontSize: 12, color: '#888' }}>No figures yet: the Rev4a daemon reads the agents every {Math.round(data.intervalS / 60)} min.</div>;
  }

  const stale = !data.collectedAt || Date.now() - data.collectedAt > data.intervalS * 3 * 1000;
  const utcTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
  // What the gateway charges right now: the band the agent's calls are billed at until the
  // next change (the rows below are history, priced as each call happened).
  const rows: [string, string][] = data.pricing ? [
    ['Rates now', `${data.pricing.vendor} ${data.pricing.band}${data.pricing.nextChange ? ` · until ${utcTime.format(new Date(data.pricing.nextChange))} UTC` : ''}`],
  ] : [];
  rows.push(
    ['Today (UTC)', formatCost(data.today)],
    ['Last 7 days', formatCost(data.week)],
    ['Last 30 days', `${formatCost(data.month)} · ${Math.round((data.tokensMonth ?? 0) / 1000)}k tokens`],
    ['Top model (30 days)', data.topModel ? `${data.topModel.model} · ${formatCost(data.topModel.cost)}` : '-'],
  );
  if (data.unpricedMonth) rows.push(['Calls without a price (30 days)', String(data.unpricedMonth)]);
  const sub = data.subscription;
  if (sub) {
    const value = sub.unpricedCalls > 0 && sub.apiValue <= 0 ? 'no price'
      : `${sub.unpricedCalls ? 'at least ' : ''}${formatCost(sub.apiValue)}`;
    rows.push(['ChatGPT subscription', `${formatTokens(sub.tokens)} tokens · API value ${value} (covered by the plan)`]);
  }
  rows.push(['Last read', data.collectedAt ? formatAge(Date.now() - data.collectedAt) : 'never']);

  return (
    <div>
      {rows.map(([label, value]) => <PanelRow key={label} label={label} value={value} />)}
      {(stale || data.error) && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--yellow)', borderBottom: '1px solid var(--border)' }}>
          {data.error ?? 'Not read recently: a stopped agent keeps the figures of its last read.'}
        </div>
      )}
      <div style={{ padding: '8px 14px', fontSize: 11 }}>
        <Link href="/costs" className="ui-link">All agents on the Costs page →</Link>
      </div>
    </div>
  );
}
