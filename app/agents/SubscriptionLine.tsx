'use client';

/**
 * Read-only lines under the pickers of the MODEL section: whether this agent is signed in to a
 * ChatGPT subscription, and whether the subscription models are still loading. The models
 * themselves are offered by the pickers (ModelSection); connecting an account happens on the
 * Subscriptions page, which this links to when the agent is not connected.
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { formatReset, reachedWindow, windowShort, type UsageAccount } from '@/app/subscriptions/usage';

export interface SubscriptionStatus {
  connected: boolean;
  usesSubscription: boolean;
  primary: string | null;
  plan?: string | null;
  email?: string | null;
  fallbacks?: string[];
  error: string | null;
}

export default function SubscriptionLine({ status, loading, modelsLoading }: {
  status: SubscriptionStatus | null;
  /** The agent's connection state is still being read. */
  loading: boolean;
  /** Connected, and the subscription models have not arrived yet. */
  modelsLoading: boolean;
}) {
  const email = status?.connected && !status.error ? (status.email ?? null) : null;
  const usage = useAccountUsage(email);

  if (loading) return <div style={{ fontSize: 11, color: '#888' }}>Subscription: checking…</div>;
  if (!status) return null;

  if (status.error) {
    return <div style={{ fontSize: 11, color: '#888' }}>Subscription: unknown</div>;
  }
  if (!status.connected) {
    return (
      <div style={{ fontSize: 11, color: '#888' }}>
        Subscription: not connected — connect it on{' '}
        <Link href="/subscriptions" style={{ color: 'var(--violet)' }}>Subscriptions</Link>
      </div>
    );
  }
  const reached = usage ? reachedWindow(usage) : null;
  const fallback = (status.fallbacks ?? []).find((f) => !f.startsWith('openai/'));
  return (
    <div style={{ fontSize: 11, color: '#888' }}>
      {usage && !reached ? (
        <>
          ChatGPT{status.plan ? ` ${status.plan}` : ''}
          {usage.windows.map((w) => ` · ${windowShort(w.label)} ${Math.max(0, 100 - Math.round(w.usedPercent))}% left`).join('')}
        </>
      ) : reached ? (
        <>
          Limit reached{formatReset(reached.resetAt) ? ` until ${formatReset(reached.resetAt)}` : ''}
          {fallback ? `: using ${fallback.replace(/^rev4a\//, '')}` : ''}
        </>
      ) : (
        <>Subscription: ChatGPT{status.plan ? ` ${status.plan}` : ''}, connected</>
      )}
      {modelsLoading && <> · Loading subscription models…</>}
    </div>
  );
}

/** The account's usage windows, loaded apart; null while loading or when it cannot be read. */
function useAccountUsage(email: string | null): UsageAccount | null {
  const [usage, setUsage] = useState<UsageAccount | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current?.abort();
    setUsage(null);
    if (!email) return;
    const read = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/subscriptions/usage?email=${encodeURIComponent(email)}`, { signal: controller.signal });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) return;
        const account = ((json.accounts ?? []) as UsageAccount[]).find((a) => a.email === email);
        if (account && account.windows.length > 0) setUsage(account);
      } catch { /* keeps the last value on error, including an abort */ }
    };
    void read();
    // Every minute while visible, and when the tab comes back (the server caches for 3 minutes).
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void read(); }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      abortRef.current?.abort();
    };
  }, [email]);
  return usage;
}
