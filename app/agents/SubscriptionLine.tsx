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
import { Button } from '@/app/components/ui';
import { getSubscriptionProvider } from '@/lib/subscription-providers';
import { EXPERIMENTAL_LABEL, getProviderCopy } from '@/app/subscriptions/providers';
import { formatReset, reachedWindow, windowShort, type UsageAccount, type UsageResponse } from '@/app/subscriptions/usage';

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

/** The part of the Claude status line this component reads (the agent's `provider=anthropic` row). */
export interface ClaudeStatus {
  connected: boolean;
  plan?: string | null;
  email?: string | null;
  error: string | null;
  claude?: { state: string } | null;
}

/** The one definition of "Claude connected": Claude Code's state is connected and the read had no error. */
export function isClaudeConnected(status: ClaudeStatus | null): boolean {
  return !!status && status.claude?.state === 'connected' && !status.error;
}

/** "Loading Claude models…", from the copy map. */
const CLAUDE_MODELS_LOADING = getProviderCopy('anthropic')?.modelsLoading ?? '';

export default function SubscriptionLine({ status, claudeStatus, loading, modelsLoading, claudeModelsLoading = false }: {
  status: SubscriptionStatus | null;
  /** The agent's Claude row, read once by ModelSection (null while loading or when it cannot be read). */
  claudeStatus: ClaudeStatus | null;
  /** The agent's ChatGPT connection state is still being read. */
  loading: boolean;
  /** Connected, and the ChatGPT subscription models have not arrived yet. */
  modelsLoading: boolean;
  /** Claude is connected and its subscription models have not arrived yet. */
  claudeModelsLoading?: boolean;
}) {
  const email = status?.connected && !status.error ? (status.email ?? null) : null;
  const usage = useAccountUsage(email, 'openai').account;
  const claudeConnected = isClaudeConnected(claudeStatus);
  const claudeEmail = claudeConnected ? (claudeStatus?.email ?? null) : null;
  const claudeRead = useAccountUsage(claudeEmail, 'anthropic');
  const claudeUsage = claudeRead.account;

  if (loading) return <div style={{ fontSize: 11, color: '#888' }}>Subscription: checking…</div>;

  const chatgptConnected = !!status?.connected && !status.error;

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
      {claudeConnected && claudeStatus && (
        <div style={{ fontSize: 11, color: '#888' }}>
          {claudeRead.termsRequired ? (
            <>
              <span>Anthropic needs this account to accept its updated terms; Claude cannot answer until then.</span>{' '}
              <Button type="button" variant="primary" size="sm" onClick={() => { window.open('https://claude.ai', '_blank', 'noopener,noreferrer'); }}>Open claude.ai</Button>
            </>
          ) : claudeUsage && !claudeReached ? (
            <>
              {CLAUDE_PROVIDER.shortName}{claudeStatus.plan ? ` ${claudeStatus.plan}` : ''}
              {claudeUsage.windows.map((w) => ` · ${windowShort(w.label)} ${Math.max(0, 100 - Math.round(w.usedPercent))}% left`).join('')}
            </>
          ) : claudeReached ? (
            <>{CLAUDE_PROVIDER.shortName}: limit reached{formatReset(claudeReached.resetAt) ? ` until ${formatReset(claudeReached.resetAt)}` : ''}</>
          ) : (
            <>Subscription: {CLAUDE_PROVIDER.shortName}{claudeStatus.plan ? ` ${claudeStatus.plan}` : ''}, connected</>
          )}
          {' · '}{EXPERIMENTAL_LABEL}
          {claudeModelsLoading && CLAUDE_MODELS_LOADING && <> · {CLAUDE_MODELS_LOADING}</>}
        </div>
      )}
    </div>
  );
}

/** The account's usage windows and terms notice, loaded together by the existing minute poll. */
function useAccountUsage(email: string | null, provider: 'openai' | 'anthropic'): { account: UsageAccount | null; termsRequired: boolean } {
  const [usage, setUsage] = useState<UsageAccount | null>(null);
  const [termsRequired, setTermsRequired] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current?.abort();
    setUsage(null);
    setTermsRequired(false);
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
        const json = await res.json().catch(() => ({})) as Partial<UsageResponse>;
        if (controller.signal.aborted || !res.ok) return;
        const terms = provider === 'anthropic' && (json.errors ?? []).some((e) => e.email === email && e.code === 'terms-required');
        const account = ((json.accounts ?? []) as UsageAccount[]).find((a) => a.email === email);
        if (terms) { setTermsRequired(true); setUsage(null); }
        else if (account && account.windows.length > 0) { setTermsRequired(false); setUsage(account); }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        // Keep the last value on a transient request failure.
      }
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
  return { account: usage, termsRequired };
}
