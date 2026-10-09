'use client';

/**
 * The usage limits of the connected ChatGPT accounts, at the top of the accordion body: one
 * block per account with a Meter for the 5-hour and the weekly window. The quota is the
 * account's (shared by every agent signed in with it and by the owner's own Codex use). It
 * loads apart from the agent rows (an OpenClaw CLI call, 11 to 50 s on a slow host, cached 3 minutes).
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
  /** The email of the account whose Refresh is running (one key, not one shared flag). */
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const refreshingRef = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const key = emails.join('\n');

  // `background`: the periodic refresh — no skeleton, no spinner, and a failure keeps what is shown.
  // `refreshEmail`: the Refresh of one account — it bypasses the server cache for that account only.
  const load = useCallback(async (refreshEmail: string | null, background = false) => {
    if (background && refreshingRef.current) return; // never abort a running Refresh
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!background) {
      if (refreshEmail) { refreshingRef.current = refreshEmail; setRefreshingKey(refreshEmail); } else setLoading(true);
      setFailed(false);
    }
    try {
      const url = refreshEmail ? `/api/subscriptions/usage?refresh=1&email=${encodeURIComponent(refreshEmail)}` : '/api/subscriptions/usage';
      const res = await fetch(url, { signal: controller.signal });
      const json = (await res.json().catch(() => ({}))) as Partial<UsageResponse>;
      if (!res.ok) throw new Error('unavailable');
      const next: UsageResponse = { accounts: json.accounts ?? [], errors: json.errors ?? [] };
      // A one-account refresh replaces only that account's entry and error.
      setData((prev) => (refreshEmail && prev
        ? {
            accounts: [...prev.accounts.filter((x) => x.email !== refreshEmail), ...next.accounts].sort((x, y) => (x.email ?? '').localeCompare(y.email ?? '')),
            errors: [...prev.errors.filter((x) => x.email !== refreshEmail), ...next.errors],
          }
        : next));
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      if (!background) setFailed(true);
    }
    if (abortRef.current === controller) { setLoading(false); refreshingRef.current = null; setRefreshingKey(null); }
  }, []);

  useEffect(() => {
    if (!key) { setData(null); return; }
    void load(null);
    // Every minute while the page is visible, and at once when the tab comes back. The server
    // reads OpenClaw at most every 3 minutes per account (its cache, failures too), so this costs the agents nothing.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(null, true); }, AUTO_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(null, true); };
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
          <Button variant="secondary" size="sm" loading={loading} onClick={() => { void load(null); }}>
            {loading ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}
      {shown.map((a) => (
        <AccountUsage key={a.email} account={a} fallbackName={fallbackName} refreshing={refreshingKey === a.email} disabled={refreshingKey !== null} onRefresh={() => { void load(a.email); }} />
      ))}
      {errors.map((e) => (
        <div key={e.email ?? e.message} style={{ fontSize: 12, color: 'var(--red)' }}>
          {e.email ? `${e.email}: ` : ''}{e.message}
        </div>
      ))}
    </div>
  );
}

function AccountUsage({ account, fallbackName, refreshing, disabled, onRefresh }: {
  account: UsageAccount;
  fallbackName: string | null;
  refreshing: boolean;
  /** Another account's Refresh is running. */
  disabled: boolean;
  onRefresh: () => void;
}) {
  const reached = reachedWindow(account);
  return (
    <div style={{ border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{account.email}{account.plan ? ` · ${account.plan}` : ''}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: DIM }}>{agoText(account.updatedAt)}</span>
          <Button variant="secondary" size="sm" loading={refreshing} disabled={disabled} onClick={onRefresh}>
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
