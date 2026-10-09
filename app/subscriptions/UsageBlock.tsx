'use client';

/**
 * The usage limits of the connected ChatGPT accounts, at the top of the accordion body: one
 * block per account with a Meter for the 5-hour and the weekly window. The quota is the
 * account's (shared by every agent signed in with it and by the owner's own Codex use). It
 * loads apart from the agent rows (an OpenClaw CLI call, about 7 s, cached 3 minutes).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How often the usage refreshes by itself while the page is visible. */
const AUTO_REFRESH_MS = 60_000;
import { Button, Meter } from '@/app/components/ui';
import { Skeleton } from '@/app/components/Skeleton';
import { agoText, formatReset, reachedWindow, usageTone, windowTitle, type UsageAccount, type UsageResponse } from './usage';

const DIM = 'var(--text-dim, #888)';

export default function UsageBlock({ emails, fallbackName }: {
  /** The emails of the connected accounts (sorted, unique); empty renders nothing. */
  emails: string[];
  /** The model the agents fall back to, when known. */
  fallbackName: string | null;
}) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const key = emails.join('\n');

  // `background`: the periodic refresh — no skeleton, no spinner, and a failure keeps what is shown.
  const load = useCallback(async (refresh: boolean, background = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!background) {
      if (refresh) setRefreshing(true); else setLoading(true);
      setFailed(false);
    }
    try {
      const res = await fetch(`/api/subscriptions/usage${refresh ? '?refresh=1' : ''}`, { signal: controller.signal });
      const json = (await res.json().catch(() => ({}))) as Partial<UsageResponse>;
      if (!res.ok) throw new Error('unavailable');
      setData({ accounts: json.accounts ?? [], errors: json.errors ?? [] });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      if (!background) setFailed(true);
    }
    if (abortRef.current === controller) { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => {
    if (!key) { setData(null); return; }
    void load(false);
    // Every minute while the page is visible, and at once when the tab comes back. The server
    // reads OpenClaw at most every 3 minutes (its cache), so this costs the agents nothing.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(false, true); }, AUTO_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(false, true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      abortRef.current?.abort();
    };
  }, [key, load]);

  if (!key) return null;

  const shown = (data?.accounts ?? []).filter((a) => a.email && emails.includes(a.email));
  const errors = data?.errors ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-busy={loading}>
      <div style={{ fontSize: 10, color: DIM, letterSpacing: '0.06em' }}>USAGE LIMITS</div>
      {loading && !data && (
        <div aria-hidden="true" style={{ display: 'grid', gap: 8 }}>
          <Skeleton width={180} height={12} />
          <Skeleton width="100%" height={8} />
          <Skeleton width="100%" height={8} />
        </div>
      )}
      {failed && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: 'var(--red)' }}>
          Could not read the usage limits.
          <Button variant="secondary" size="sm" loading={loading} onClick={() => { void load(false); }}>
            {loading ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}
      {shown.map((a) => (
        <AccountUsage key={a.email} account={a} fallbackName={fallbackName} refreshing={refreshing} onRefresh={() => { void load(true); }} />
      ))}
      {errors.map((e) => (
        <div key={e.email ?? e.message} style={{ fontSize: 12, color: 'var(--red)' }}>
          {e.email ? `${e.email}: ` : ''}{e.message}
        </div>
      ))}
    </div>
  );
}

function AccountUsage({ account, fallbackName, refreshing, onRefresh }: {
  account: UsageAccount;
  fallbackName: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const reached = reachedWindow(account);
  return (
    <div style={{ border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{account.email}{account.plan ? ` · ${account.plan}` : ''}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: DIM }}>{agoText(account.updatedAt)}</span>
          <Button variant="secondary" size="sm" loading={refreshing} onClick={onRefresh}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>
      {account.windows.map((w) => {
        const reset = formatReset(w.resetAt);
        const pct = Math.round(w.usedPercent);
        return (
          <div key={w.label} style={{ display: 'grid', gap: 4 }}>
            <div style={{ fontSize: 11, color: DIM }}>{windowTitle(w.label)}</div>
            <Meter percent={w.usedPercent} level={usageTone(w.usedPercent)} label={`${windowTitle(w.label)} usage`} />
            <div style={{ fontSize: 11 }}>{pct}% used{reset ? ` · resets ${/^\d/.test(reset) ? 'at ' : ''}${reset}` : ''}</div>
          </div>
        );
      })}
      {reached && (
        <div style={{ fontSize: 12, color: 'var(--red)' }}>
          Limit reached: connected agents use their fallback model{fallbackName ? ` (${fallbackName})` : ''}
          {formatReset(reached.resetAt) ? ` until ${formatReset(reached.resetAt)}` : ''}.
        </div>
      )}
    </div>
  );
}
