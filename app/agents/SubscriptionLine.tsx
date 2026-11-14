'use client';

/**
 * Read-only lines under the pickers of the MODEL section: one per connected subscription
 * provider — ChatGPT's line as before (plan, usage windows, or "not connected") and, when the
 * agent's Claude plan is connected, a second line marked Experimental. The models themselves
 * are offered by the pickers (ModelSection); connecting an account happens on the Subscriptions
 * page, which this links to when no provider is connected.
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { getSubscriptionProvider } from '@/lib/subscription-providers';
import { EXPERIMENTAL_LABEL, getProviderCopy } from '@/app/subscriptions/providers';
import { formatReset, reachedWindow, windowShort, type UsageAccount } from '@/app/subscriptions/usage';

/**
 * The provider of the ChatGPT line: the ChatGPT (Codex) sign-in itself, bound explicitly so a
 * change of default provider cannot repoint the line at another account.
 */
const FOUND_PROVIDER = getSubscriptionProvider('openai');
if (!FOUND_PROVIDER) throw new Error('The openai subscription provider is missing from the registry.');
const PROVIDER = FOUND_PROVIDER;

/** The Claude descriptor, for the second line's short name. */
const FOUND_CLAUDE = getSubscriptionProvider('anthropic');
if (!FOUND_CLAUDE) throw new Error('The anthropic subscription provider is missing from the registry.');
const CLAUDE_PROVIDER = FOUND_CLAUDE;

export interface SubscriptionStatus {
  connected: boolean;
  usesSubscription: boolean;
  primary: string | null;
  plan?: string | null;
  email?: string | null;
  fallbacks?: string[];
  error: string | null;
}

/** The part of the Claude status line this component reads. */
interface ClaudeStatus {
  connected: boolean;
  plan: string | null;
  email?: string | null;
  error: string | null;
  claude?: { state: string } | null;
}

/** "Loading Claude models…", from the copy map. */
const CLAUDE_MODELS_LOADING = getProviderCopy('anthropic')?.modelsLoading ?? '';

export default function SubscriptionLine({ agentId, status, loading, modelsLoading, claudeModelsLoading = false }: {
  /** The agent whose Claude status the line reads separately. */
  agentId: string;
  status: SubscriptionStatus | null;
  /** The agent's ChatGPT connection state is still being read. */
  loading: boolean;
  /** Connected, and the ChatGPT subscription models have not arrived yet. */
  modelsLoading: boolean;
  /** Claude is connected and its subscription models have not arrived yet. */
  claudeModelsLoading?: boolean;
}) {
  const email = status?.connected && !status.error ? (status.email ?? null) : null;
  const usage = useAccountUsage(email, 'openai');
  const claude = useClaudeStatus(agentId);
  const claudeEmail = claude.status?.connected && !claude.status.error ? (claude.status.email ?? null) : null;
  const claudeUsage = useAccountUsage(claudeEmail, 'anthropic');

  if (loading) return <div style={{ fontSize: 11, color: '#888' }}>Subscription: checking…</div>;

  const chatgptConnected = !!status?.connected && !status.error;
  const claudeConnected = !!claude.status?.connected && !claude.status.error;

  // Neither provider is connected: today's ChatGPT line, exactly as before. The Claude read does
  // not hold this line back (it can take much longer than the ChatGPT one).
  if (!chatgptConnected && !claudeConnected) {
    // No ChatGPT status (read failed or no data): nothing, as before Claude existed.
    if (!status) return null;
    if (status.error) {
      return <div style={{ fontSize: 11, color: '#888' }}>Subscription: unknown</div>;
    }
    return (
      <div style={{ fontSize: 11, color: '#888' }}>
        Subscription: not connected — connect it on{' '}
        <Link href="/subscriptions" style={{ color: 'var(--violet)' }}>Subscriptions</Link>
      </div>
    );
  }

  const reached = usage ? reachedWindow(usage) : null;
  const claudeReached = claudeUsage ? reachedWindow(claudeUsage) : null;
  const fallback = (status?.fallbacks ?? []).find((f) => !f.startsWith(PROVIDER.modelPrefix));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {chatgptConnected && status && (
        <div style={{ fontSize: 11, color: '#888' }}>
          {usage && !reached ? (
            <>
              {PROVIDER.shortName}{status.plan ? ` ${status.plan}` : ''}
              {usage.windows.map((w) => ` · ${windowShort(w.label)} ${Math.max(0, 100 - Math.round(w.usedPercent))}% left`).join('')}
            </>
          ) : reached ? (
            <>
              Limit reached{formatReset(reached.resetAt) ? ` until ${formatReset(reached.resetAt)}` : ''}
              {fallback ? `: using ${fallback.replace(/^rev4a\//, '')}` : ''}
            </>
          ) : (
            <>Subscription: {PROVIDER.shortName}{status.plan ? ` ${status.plan}` : ''}, connected</>
          )}
          {modelsLoading && <> · Loading subscription models…</>}
        </div>
      )}
      {!chatgptConnected && status?.error && (
        // A ChatGPT read that failed stays visible next to a connected Claude plan.
        <div style={{ fontSize: 11, color: '#888' }}>Subscription: unknown</div>
      )}
      {claudeConnected && claude.status && (
        <div style={{ fontSize: 11, color: '#888' }}>
          {claudeUsage && !claudeReached ? (
            <>
              {CLAUDE_PROVIDER.shortName}{claude.status.plan ? ` ${claude.status.plan}` : ''}
              {claudeUsage.windows.map((w) => ` · ${windowShort(w.label)} ${Math.max(0, 100 - Math.round(w.usedPercent))}% left`).join('')}
            </>
          ) : claudeReached ? (
            <>{CLAUDE_PROVIDER.shortName}: limit reached{formatReset(claudeReached.resetAt) ? ` until ${formatReset(claudeReached.resetAt)}` : ''}</>
          ) : (
            <>Subscription: {CLAUDE_PROVIDER.shortName}{claude.status.plan ? ` ${claude.status.plan}` : ''}, connected</>
          )}
          {' · '}{EXPERIMENTAL_LABEL}
          {claudeModelsLoading && CLAUDE_MODELS_LOADING && <> · {CLAUDE_MODELS_LOADING}</>}
        </div>
      )}
    </div>
  );
}

/** The agent's Claude connection, read apart; null while loading or when it cannot be read. */
function useClaudeStatus(agentId: string): { status: ClaudeStatus | null; loading: boolean } {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/subscriptions?agentId=${encodeURIComponent(agentId)}&provider=anthropic`,
          { signal: controller.signal },
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.agent) throw new Error('unavailable');
        if (abortRef.current === controller) setStatus(json.agent as ClaudeStatus);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        if (abortRef.current === controller) setStatus(null);
      }
      if (abortRef.current === controller) setLoading(false);
    })();
    return () => controller.abort();
  }, [agentId]);
  return { status, loading };
}

/** The account's usage windows, loaded apart; null while loading or when it cannot be read. */
function useAccountUsage(email: string | null, provider: 'openai' | 'anthropic'): UsageAccount | null {
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
        const res = await fetch(
          // The ChatGPT URL stays exactly what it was before the provider parameter existed.
          `/api/subscriptions/usage?email=${encodeURIComponent(email)}${provider === 'openai' ? '' : `&provider=${provider}`}`,
          { signal: controller.signal },
        );
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
  }, [email, provider]);
  return usage;
}
