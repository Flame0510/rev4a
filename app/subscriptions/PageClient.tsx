'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Accordion, Button, ConfirmModal, Input, Modal, Page, PageHeader, Pill, showToast } from '@/app/components/ui';
import type { SubscriptionProfileReference } from '@/lib/subscriptions-parse';
import {
  DEFAULT_SUBSCRIPTION_PROVIDER,
  getSubscriptionProvider,
  type SubscriptionProvider,
} from '@/lib/subscription-providers';
import { getProviderCopy, type SubscriptionProviderCopy, SUBSCRIPTIONS_PAGE_DESCRIPTION, EXPERIMENTAL_LABEL, CLAUDE_USAGE_NOTE, CLAUDE_USAGE_LINK, claudeRowView } from './providers';
import { Skeleton } from '@/app/components/Skeleton';
import UsageBlock from './UsageBlock';
import ClaudeConnectModal from './ClaudeConnectModal';
import {
  SubscriptionsBodySkeleton,
  SubscriptionsModelsSkeleton,
} from './SubscriptionsSkeleton';

interface SubModel { key: string; name: string; contextWindow: number | null }
/** One entry of the list the page gets at once (docker only, nothing asked of the agent). */
interface ListAgent { agentId: string; name: string; container: string; running: boolean }
/** One agent's own status, read when its row loads. */
interface SubAgent extends ListAgent {
  connected: boolean;
  email: string | null;
  plan: string | null;
  expiresAt: string | null;
  profileReferences?: SubscriptionProfileReference[];
  usesSubscription: boolean;
  primary: string | null;
  fallbacks: string[];
  error: string | null;
  /** Present on a Claude row: the state the server derives from Claude Code and the model rule. */
  claude?: { state: 'not-installed' | 'signed-out' | 'route-off' | 'connected' | 'needs-reconnect'; installed: boolean; version: string | null; apiAccount?: true };
}
interface Job { agentId: string; kind: 'logout' | 'claude-logout'; state: 'running' | 'done' | 'failed'; error: string | null }
interface Row {
  status: SubAgent | null;
  loading: boolean;
  /** The status read failed. */
  error: string | null;
  /** The running action (or the one that just failed), shown on the row. */
  job: Job | null;
  /** The message of a failed action, until the next one. */
  notice: string | null;
}
/** `pending`: an account is connected but its agent is still loading the provider catalogue. */
interface Models { list: SubModel[]; error: string | null; loading: boolean; pending: boolean }

type LoginState = 'starting' | 'waiting' | 'connected' | 'failed' | 'expired' | 'cancelled';
interface Login {
  agentId: string;
  state: LoginState;
  url: string | null;
  code: string | null;
  expiresAt: number | null;
  email: string | null;
  error: string | null;
}

/** One provider from `GET /api/subscriptions`, with its registry entry and its UI copy. */
interface ProviderView {
  provider: SubscriptionProvider;
  copy: SubscriptionProviderCopy;
  agents: ListAgent[];
}

const POLL_MS = 1500;
/** How often, and for how long, to ask again while the provider catalogue is still loading after Connect. */
const MODELS_RETRY_MS = 5_000;
const MODELS_WAIT_MS = 3 * 60_000;
const POLL_BACKOFF_MAX_MS = 15000;
const POLL_GIVE_UP_MS = 2 * 60 * 1000;
const EMPTY_ROW: Row = { status: null, loading: true, error: null, job: null, notice: null };
const EMPTY_MODELS: Models = { list: [], error: null, loading: true, pending: false };

/**
 * The `provider` query parameter for a read route: the default provider's URLs stay exactly as
 * they were (no parameter), so an older server keeps answering and live tests keep matching.
 */
const providerParam = (providerId: string): string =>
  providerId === DEFAULT_SUBSCRIPTION_PROVIDER.id ? '' : `?provider=${encodeURIComponent(providerId)}`;

/**
 * The same provider parameter as an `&` suffix, for a route URL that already has a query
 * (`GET /api/subscriptions?agentId=`). The default provider's URL stays byte-for-byte as before.
 */
const providerAnd = (providerId: string): string =>
  providerId === DEFAULT_SUBSCRIPTION_PROVIDER.id ? '' : `&provider=${encodeURIComponent(providerId)}`;

/**
 * One key for every per-agent map: the same agent can appear under two provider accordions (one
 * per provider it is connected to), so an agent id alone no longer identifies a row.
 */
const rowKey = (providerId: string, agentId: string): string => `${providerId}:${agentId}`;

/** The accordion the page shows when the server names no provider this build knows, as before the registry. */
function defaultProviderView(): ProviderView[] {
  const copy = getProviderCopy(DEFAULT_SUBSCRIPTION_PROVIDER.id);
  return copy ? [{ provider: DEFAULT_SUBSCRIPTION_PROVIDER, copy, agents: [] }] : [];
}

/** A JSON body, failing on anything that is not a 2xx (a proxy page parses to {}). */
async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const formatContext = (n: number | null) => (n ? `${Math.round(n / 1000).toLocaleString()}k context` : '');
const bare = (id: string) => id.replace(/^rev4a\//, '');
/** The model an agent goes back to when it is disconnected: its first own fallback, or its own primary. */
const ownModelName = (a: { primary: string | null; fallbacks: string[] }, prefix: string): string => {
  const own = a.fallbacks.find((f) => !f.startsWith(prefix)) ?? (a.primary && !a.primary.startsWith(prefix) ? a.primary : null);
  return own ? bare(own) : 'its own model';
};
const modelName = (id: string, prefix: string): string =>
  id.startsWith('rev4a/') ? id.slice('rev4a/'.length) : id.startsWith(prefix) ? id.slice(prefix.length) : id;

export default function SubscriptionsPageClient() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  /** Rows are keyed by provider id, then by agent id: the same agent can appear under two providers. */
  const [rows, setRows] = useState<Record<string, Record<string, Row>>>({});
  const [models, setModels] = useState<Record<string, Models>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ [DEFAULT_SUBSCRIPTION_PROVIDER.id]: true });
  const [connectAgent, setConnectAgent] = useState<{ providerId: string; agentId: string } | null>(null);
  /** The agent whose disconnect awaits the operator's confirmation. */
  const [confirmDisconnect, setConfirmDisconnect] = useState<{ providerId: string; agent: SubAgent } | null>(null);

  // One AbortController per row for its status read, one per row for its job poll: a newer
  // request cancels the one still in flight (AGENTS.md §2.2b rule 10). Models have one each.
  const rowAbort = useRef(new Map<string, AbortController>());
  const pollAbort = useRef(new Map<string, AbortController>());
  const pollTimer = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const modelsAbort = useRef(new Map<string, AbortController>());
  const modelsTimer = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const listAbort = useRef<AbortController | null>(null);
  // Rows with an action being started (rowKey): guards a double click before React commits the disabled buttons.
  const starting = useRef(new Set<string>());
  const alive = useRef(true);

  /** Update one agent's row inside its provider's bucket, addressed by provider and agent id. */
  const patchRow = useCallback((providerId: string, agentId: string, patch: Partial<Row>) => {
    setRows((r) => {
      const mine = r[providerId] ?? {};
      return { ...r, [providerId]: { ...mine, [agentId]: { ...(mine[agentId] ?? EMPTY_ROW), ...patch } } };
    });
  }, []);

  const loadModels = useCallback(async (providerId: string) => {
    const provider = getSubscriptionProvider(providerId);
    const copy = getProviderCopy(providerId);
    if (!provider || !copy) return;
    modelsAbort.current.get(providerId)?.abort();
    const previous = modelsTimer.current.get(providerId);
    if (previous) clearTimeout(previous);
    const controller = new AbortController();
    modelsAbort.current.set(providerId, controller);
    const startedAt = Date.now();
    setModels((m) => ({ ...m, [providerId]: { ...(m[providerId] ?? EMPTY_MODELS), loading: true, pending: false } }));
    const expire = () => {
      controller.abort();
      if (alive.current) {
        setModels((m) => ({ ...m, [providerId]: { ...(m[providerId] ?? EMPTY_MODELS), error: copy.modelsUnavailable, loading: false, pending: false } }));
      }
    };
    // Abort an outstanding request/body read at the deadline, not just between retries.
    const deadline = setTimeout(expire, MODELS_WAIT_MS);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(deadline);
      const t = modelsTimer.current.get(providerId);
      if (t) clearTimeout(t);
    }, { once: true });
    // Right after Connect the agent needs about a minute to load the provider catalogue: the server
    // answers `pending` until then. Show that, and ask again until the models arrive.
    const read = async () => {
      if (!alive.current || controller.signal.aborted) return;
      if (Date.now() - startedAt >= MODELS_WAIT_MS) {
        expire();
        return;
      }
      try {
        const json = await readJson<{ models: SubModel[]; error: string | null; pending?: boolean }>(
          await fetch(`/api/subscriptions/models${providerParam(provider.id)}`, { signal: controller.signal }),
        );
        if (!alive.current || controller.signal.aborted) return;
        if (Date.now() - startedAt >= MODELS_WAIT_MS) { expire(); return; }
        const waiting = !!json.pending && Date.now() - startedAt < MODELS_WAIT_MS;
        setModels((m) => ({
          ...m,
          [provider.id]: {
            list: json.models ?? [],
            error: json.error ?? (json.pending && !waiting ? copy.modelsUnavailable : null),
            loading: false,
            pending: waiting,
          },
        }));
        if (waiting) modelsTimer.current.set(provider.id, setTimeout(() => { void read(); }, Math.min(MODELS_RETRY_MS, MODELS_WAIT_MS - (Date.now() - startedAt))));
        else clearTimeout(deadline);
      } catch (e) {
        if (!alive.current || controller.signal.aborted || (e as Error)?.name === 'AbortError') return;
        clearTimeout(deadline);
        setModels((m) => ({ ...m, [provider.id]: { list: [], error: 'Could not read the models.', loading: false, pending: false } }));
      }
    };
    await read();
  }, []);

  const stopPoll = useCallback((key: string) => {
    pollAbort.current.get(key)?.abort();
    pollAbort.current.delete(key);
    const t = pollTimer.current.get(key);
    if (t) clearTimeout(t);
    pollTimer.current.delete(key);
  }, []);

  // `loadRow` and `pollJob` call each other (a finished job refreshes its row; a row that
  // reads a running job polls it), so they are reached through a ref.
  const api = useRef<{
    loadRow: (providerId: string, agentId: string) => Promise<void>;
    pollJob: (providerId: string, agentId: string) => void;
  }>({
    loadRow: async () => {},
    pollJob: () => {},
  });

  api.current.loadRow = async (providerId: string, agentId: string) => {
    const key = rowKey(providerId, agentId);
    rowAbort.current.get(key)?.abort();
    const controller = new AbortController();
    rowAbort.current.set(key, controller);
    patchRow(providerId, agentId, { loading: true });
    try {
      // The status route is addressed by agent id, plus the provider when it is not the default.
      const json = await readJson<{ agent: SubAgent; action: Job | null }>(
        await fetch(`/api/subscriptions?agentId=${encodeURIComponent(agentId)}${providerAnd(providerId)}`, { signal: controller.signal }),
      );
      if (!alive.current || controller.signal.aborted || rowAbort.current.get(key) !== controller) return;
      const running = json.action?.state === 'running' ? json.action : null;
      patchRow(providerId, agentId, { status: json.agent, loading: false, error: null, job: running });
      if (running) api.current.pollJob(providerId, agentId);
    } catch (e) {
      if (!alive.current || controller.signal.aborted || rowAbort.current.get(key) !== controller || (e as Error)?.name === 'AbortError') return;
      patchRow(providerId, agentId, { loading: false, error: (e as Error).message || 'Could not read this agent.' });
    }
  };

  api.current.pollJob = (providerId: string, agentId: string) => {
    const provider = getSubscriptionProvider(providerId);
    if (!provider) return;
    const key = rowKey(providerId, agentId);
    stopPoll(key);
    let failingSince: number | null = null;
    let delay = POLL_MS;
    const tick = async () => {
      if (!alive.current) return;
      const controller = new AbortController();
      pollAbort.current.set(key, controller);
      let job: Job | null | undefined;
      try {
        const json = await readJson<{ job: Job | null }>(
          await fetch(`${provider.logoutPath}?agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal }),
        );
        job = json.job;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        job = undefined; // a failed poll: try again, backing off
      }
      if (job === undefined) {
        failingSince ??= Date.now();
        if (Date.now() - failingSince >= POLL_GIVE_UP_MS) {
          pollAbort.current.delete(key);
          pollTimer.current.delete(key);
          patchRow(providerId, agentId, { job: null, loading: false, error: 'Lost track of the disconnect. Refresh the row.' });
          return;
        }
        pollTimer.current.set(key, setTimeout(() => { void tick(); }, delay));
        delay = Math.min(delay * 2, POLL_BACKOFF_MAX_MS);
        return;
      }
      failingSince = null;
      delay = POLL_MS;
      if (job && job.state === 'running') {
        pollTimer.current.set(key, setTimeout(() => { void tick(); }, POLL_MS));
        return;
      }
      pollAbort.current.delete(key);
      pollTimer.current.delete(key);
      // Done, failed, or no longer known (the dashboard restarted): read the row again.
      patchRow(providerId, agentId, { job: null, notice: job?.state === 'failed' ? (job.error ?? 'The change failed.') : null });
      if (job?.state === 'done') showToast('Disconnected', 'success');
      await api.current.loadRow(providerId, agentId);
      void loadModels(provider.id);
    };
    pollTimer.current.set(key, setTimeout(() => { void tick(); }, POLL_MS));
  };

  const loadAll = useCallback(async () => {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    // The default provider's models load as soon as the page does, exactly as before.
    void loadModels(DEFAULT_SUBSCRIPTION_PROVIDER.id);
    try {
      const json = await readJson<{ providers: { id: string; name: string; agents: ListAgent[] }[] }>(
        await fetch('/api/subscriptions', { signal: controller.signal }),
      );
      // A body without the list (a proxy page parses to {}) is a failed load, exactly as before the
      // registry existed: never a silent empty page.
      if (!Array.isArray(json.providers)) throw new Error('Could not load subscriptions');
      // Keep only the providers this build knows (registry and copy map): an id from a newer
      // server is ignored, never rendered broken.
      const known: ProviderView[] = [];
      for (const p of json.providers) {
        const provider = getSubscriptionProvider(p.id);
        const copy = getProviderCopy(p.id);
        if (!provider || !copy) continue;
        known.push({ provider, copy, agents: p.agents ?? [] });
        if (provider.id !== DEFAULT_SUBSCRIPTION_PROVIDER.id) void loadModels(provider.id);
      }
      // No provider this build knows: show the default accordion with no agents, as the old page did.
      setProviders(known.length > 0 ? known : defaultProviderView());
      setError(null);
      setRows((r) => {
        const next = { ...r };
        for (const p of known) {
          const mine = { ...(r[p.provider.id] ?? {}) };
          for (const a of p.agents) {
            mine[a.agentId] = a.running
              ? mine[a.agentId] ?? EMPTY_ROW
              : { status: { ...a, connected: false, email: null, plan: null, expiresAt: null, usesSubscription: false, primary: null, fallbacks: [], error: null }, loading: false, error: null, job: null, notice: null };
          }
          next[p.provider.id] = mine;
        }
        return next;
      });
      // Every running row loads its own status, in parallel.
      for (const p of known) {
        for (const a of p.agents) if (a.running) void api.current.loadRow(p.provider.id, a.agentId);
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      setError((e as Error).message || 'Could not load subscriptions');
      // Keep what was already shown; a first load that failed still shows the default provider,
      // as it did before the registry existed.
      setProviders((list) => list ?? defaultProviderView());
    }
  }, [loadModels]);

  useEffect(() => {
    alive.current = true;
    void loadAll();
    const rowAborts = rowAbort.current;
    const pollAborts = pollAbort.current;
    const timers = pollTimer.current;
    const modelAborts = modelsAbort.current;
    const modelTimers = modelsTimer.current;
    return () => {
      alive.current = false;
      listAbort.current?.abort();
      modelAborts.forEach((c) => c.abort());
      modelTimers.forEach((t) => clearTimeout(t));
      rowAborts.forEach((c) => c.abort());
      pollAborts.forEach((c) => c.abort());
      timers.forEach((t) => clearTimeout(t));
    };
  }, [loadAll]);

  const disconnect = async (provider: SubscriptionProvider, agent: SubAgent) => {
    const key = rowKey(provider.id, agent.agentId);
    if (starting.current.has(key)) return;
    starting.current.add(key);
    // The optimistic job carries the same kind the server reports for this provider.
    const kind: Job['kind'] = provider.loginKind === 'link-code' ? 'claude-logout' : 'logout';
    patchRow(provider.id, agent.agentId, { job: { agentId: agent.agentId, kind, state: 'running', error: null }, notice: null });
    try {
      await readJson<{ job: Job }>(await fetch(provider.logoutPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.agentId }),
      }));
      api.current.pollJob(provider.id, agent.agentId);
    } catch (e) {
      patchRow(provider.id, agent.agentId, { job: null, notice: (e as Error).message });
    }
    starting.current.delete(key);
  };

  if (providers === null) {
    return (
      <Page maxWidth={1080}>
        <PageHeader eyebrow="" title="Subscriptions" description={SUBSCRIPTIONS_PAGE_DESCRIPTION} />
        <SubscriptionsBodySkeleton />
      </Page>
    );
  }

  const connectView = connectAgent ? providers.find((p) => p.provider.id === connectAgent.providerId) ?? null : null;
  const connectTargetAgent = connectView && connectAgent ? connectView.agents.find((a) => a.agentId === connectAgent.agentId) ?? null : null;
  const connectName = connectTargetAgent?.name ?? connectAgent?.agentId ?? '';
  const disconnectProvider = confirmDisconnect ? getSubscriptionProvider(confirmDisconnect.providerId) : null;

  /** Close the connect dialog, then read the row and the models again: the account may have changed. */
  const closeConnect = () => {
    const id = connectAgent;
    setConnectAgent(null);
    if (id) {
      void api.current.loadRow(id.providerId, id.agentId);
      void loadModels(id.providerId);
    }
  };

  return (
    <Page maxWidth={1080}>
      <PageHeader eyebrow="" title="Subscriptions" description={SUBSCRIPTIONS_PAGE_DESCRIPTION} />

      {error && (
        <div style={{ padding: '10px 14px', background: 'var(--bg2)', border: '1px solid var(--red)', color: 'var(--red)', fontSize: 12, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {providers.map(({ provider, copy, agents }) => {
          const providerRows = rows[provider.id] ?? {};
          const providerModels = models[provider.id] ?? EMPTY_MODELS;
          const statuses = agents.map((a) => providerRows[a.agentId]?.status).filter((s): s is SubAgent => !!s);
          const allLoaded = agents.every((a) => { const r = providerRows[a.agentId]; return !!r && !r.loading; });
          const connected = statuses.filter((s) => s.connected);
          const accounts = [...new Map(connected.filter((s) => s.email).map((s) => [s.email as string, s.plan])).entries()];
          const sampleFallback = statuses.find((s) => s.usesSubscription && s.fallbacks.find((f) => !f.startsWith(provider.modelPrefix)));
          const fallbackModel = sampleFallback?.fallbacks.find((f) => !f.startsWith(provider.modelPrefix)) ?? null;
          const usageEmails = allLoaded ? [...new Set(connected.map((s) => s.email).filter((e): e is string => !!e))].sort() : [];

          return (
            <Accordion
              key={provider.id}
              id={`sub-${provider.id}`}
              open={!!open[provider.id]}
              onToggle={() => setOpen((o) => ({ ...o, [provider.id]: !o[provider.id] }))}
              title={<>{provider.name}{provider.experimental ? <> <Pill>{EXPERIMENTAL_LABEL}</Pill></> : null}</>}
              summary={allLoaded ? `${connected.length} of ${agents.length} agents connected` : <Skeleton as="span" inline width={140} height={12} />}
              detail={accounts.length ? accounts.map(([email, plan]) => (plan ? `${email} (${plan})` : email)).join(', ') : undefined}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' }}>
                {provider.hasUsage && (
                  <UsageBlock
                    provider={provider}
                    emails={usageEmails}
                    fallbackName={fallbackModel ? bare(fallbackModel) : null}
                  />
                )}

                <div>
                  {providerModels.loading && providerModels.list.length === 0 ? (
                    <SubscriptionsModelsSkeleton />
                  ) : (
                    <>
                      <div style={{ fontSize: 10, color: 'var(--text-dim, #888)', letterSpacing: '0.06em', marginBottom: 6 }}>MODELS</div>
                      {providerModels.list.length === 0 && providerModels.pending ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dim, #888)' }}>
                          <Pill>{copy.modelsLoading}</Pill>
                          {copy.modelsPending}
                        </div>
                      ) : providerModels.list.length === 0 ? (
                        <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>
                          {providerModels.error ?? 'Connect an agent to see the models your account offers.'}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {providerModels.list.map((m) => (
                            <span key={m.key} style={{ fontSize: 12, border: '1px solid var(--border)', padding: '4px 8px' }}>
                              {m.name}
                              {m.contextWindow ? <span style={{ color: 'var(--text-dim, #888)' }}> · {formatContext(m.contextWindow)}</span> : null}
                            </span>
                          ))}
                        </div>
                      )}
                      {providerModels.list.length > 0 && (providerModels.pending || providerModels.error) ? (
                        <div role="status" style={{ fontSize: 12, color: 'var(--text-dim, #888)', marginTop: 6 }}>
                          {providerModels.pending ? 'Loading models for another connected account…' : providerModels.error}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>

                <div style={{ display: 'grid', gap: 8 }}>
                  {agents.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>No agents yet.</div>}
                  {agents.map((a) => (
                    <AgentRow
                      key={a.agentId}
                      provider={provider}
                      copy={copy}
                      agent={a}
                      row={providerRows[a.agentId] ?? EMPTY_ROW}
                      connecting={!!connectAgent && connectAgent.providerId === provider.id && connectAgent.agentId === a.agentId}
                      onConnect={() => setConnectAgent({ providerId: provider.id, agentId: a.agentId })}
                      onRetry={() => { void api.current.loadRow(provider.id, a.agentId); }}
                      onDisconnect={(s) => setConfirmDisconnect({ providerId: provider.id, agent: s })}
                    />
                  ))}
                </div>

                <div style={{ fontSize: 11, color: 'var(--text-dim, #888)', lineHeight: 1.5 }}>
                  {provider.loginKind === 'link-code' ? (
                    <>
                      {copy.usageShared}{' '}{CLAUDE_USAGE_NOTE}{' '}
                      <a href={CLAUDE_USAGE_LINK.href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--violet)' }}>
                        {CLAUDE_USAGE_LINK.label}
                      </a>
                    </>
                  ) : (
                    <>
                      When the subscription reaches its usage limit the agent falls back to its own model
                      {fallbackModel ? ` (${bare(fallbackModel)})` : ''}.
                      {' '}{copy.usageShared}
                    </>
                  )}
                </div>
              </div>
            </Accordion>
          );
        })}
      </div>

      <ConfirmModal
        open={!!confirmDisconnect}
        onClose={() => setConfirmDisconnect(null)}
        onConfirm={() => {
          const target = confirmDisconnect;
          setConfirmDisconnect(null);
          if (target && disconnectProvider) void disconnect(disconnectProvider, target.agent);
        }}
        title="Disconnect agent"
        message={confirmDisconnect && disconnectProvider
          ? getProviderCopy(confirmDisconnect.providerId)?.disconnectMessage(confirmDisconnect.agent.name, ownModelName(confirmDisconnect.agent, disconnectProvider.modelPrefix)) ?? ''
          : ''}
        confirmLabel="Disconnect"
      />

      {connectAgent && connectView && connectView.provider.loginKind === 'link-code' && (
        <ClaudeConnectModal
          agentId={connectAgent.agentId}
          agentName={connectName}
          copy={connectView.copy}
          loginPath={connectView.provider.loginPath}
          onClose={closeConnect}
          onConnected={(email) => {
            const id = connectAgent;
            showToast(`${connectName} connected${email ? ` as ${email}` : ''}`, 'success');
            if (id) {
              void api.current.loadRow(id.providerId, id.agentId);
              void loadModels(id.providerId);
            }
          }}
        />
      )}

      {connectAgent && connectView && connectView.provider.loginKind === 'device-code' && (
        <ConnectModal
          provider={connectView.provider}
          copy={connectView.copy}
          agentId={connectAgent.agentId}
          agentName={connectName}
          onClose={closeConnect}
          onConnected={(email) => { showToast(`${connectName} connected${email ? ` as ${email}` : ''}`, 'success'); }}
        />
      )}
    </Page>
  );
}

function AgentRow({ provider, copy, agent, row, connecting, onConnect, onRetry, onDisconnect }: {
  /** The provider whose model prefix the row uses: always passed by the page. */
  provider: SubscriptionProvider;
  /** The provider's UI copy: always passed by the page. */
  copy: SubscriptionProviderCopy;
  agent: ListAgent;
  row: Row;
  /** The connect dialog is open (or its login is starting) for this row. */
  connecting?: boolean;
  onConnect: () => void;
  onRetry: () => void;
  onDisconnect: (s: SubAgent) => void;
}) {
  const a = row.status;
  const running = row.job?.state === 'running' ? row.job : null;
  const secondary = agent.container !== agent.name ? agent.container : null;
  const modelPrefix = provider.modelPrefix;
  const accountLabel = copy.accountLabel;

  const head = (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-all' }}>{agent.name}</div>
      {secondary && <div style={{ fontSize: 10, color: 'var(--text-dim, #888)', wordBreak: 'break-all' }}>{secondary}</div>}
    </>
  );

  // The status is still loading: the name is known, the rest is a skeleton line.
  if (!a) {
    return (
      <div style={{ border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          {head}
          <div style={{ marginTop: 4 }}>
            {row.error ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--red)' }}>{row.error}</span>
                <Button type="button" variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
              </div>
            ) : (
              <Skeleton width={150} height={20} />
            )}
          </div>
        </div>
        <div style={{ flex: '0 1 260px', minWidth: 180 }}><Skeleton height={32} /></div>
        <Skeleton width={84} height={28} />
      </div>
    );
  }

  let tone: 'success' | 'neutral' | 'warning' | 'danger' = 'neutral';
  let status = 'Not connected';
  const claude = provider.loginKind === 'link-code' ? claudeRowView(a, copy, formatDate) : null;
  if (claude) {
    tone = claude.tone;
    status = claude.status;
  } else if (!a.running) { tone = 'neutral'; status = 'Stopped'; }
  else if (a.error) { tone = 'danger'; status = 'Error'; }
  else if (a.connected) { tone = 'success'; status = a.expiresAt ? `Connected until ${formatDate(a.expiresAt)}` : 'Connected'; }

  // An open connect dialog (or a login starting) makes this row busy too: its other actions
  // (Disconnect on a route-off or needs-reconnect row) must not race the sign-in.
  const busy = !!running || row.loading || !!connecting;
  const disconnecting = !!running;
  const rowCopy = copy.row;
  const showAccount = claude ? claude.account : a.connected;
  const showModel = a.connected;

  return (
    <div style={{ border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        {head}
        <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Pill tone={tone}>{status}</Pill>
          {showAccount && a.email && (
            <span style={{ fontSize: 11, color: 'var(--text-dim, #888)' }}>{a.email}{a.plan ? ` · ${a.plan}` : ''}</span>
          )}
        </div>
        {a.error && (
          <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--red)' }}>{a.error}</span>
            <Button type="button" variant="secondary" size="sm" disabled={busy} loading={row.loading} onClick={onRetry}>{row.loading ? 'Retrying…' : 'Retry'}</Button>
          </div>
        )}
        {row.error && (
          <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--red)' }}>{row.error} The status above may be out of date.</span>
            <Button type="button" variant="secondary" size="sm" disabled={row.loading} loading={row.loading} onClick={onRetry}>Retry</Button>
          </div>
        )}
        {row.notice && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{row.notice}</div>}
        {!a.running && <div style={{ fontSize: 11, color: 'var(--text-dim, #888)', marginTop: 4 }}>Stopped, status unknown. Start the agent to connect it.</div>}
        {a.running && showModel && a.primary && (
          <div style={{ fontSize: 11, color: 'var(--text-dim, #888)', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span>
              Model: {modelName(a.primary, modelPrefix)}
              {a.fallbacks[0] ? ` · fallback ${modelName(a.fallbacks[0], modelPrefix)}` : ''}
            </span>
            <Link href={`/agents?agent=${encodeURIComponent(agent.agentId)}`} style={{ color: 'var(--violet)' }}>Change in the agent panel</Link>
          </div>
        )}
        {a.running && a.connected && Array.isArray(a.profileReferences) && a.profileReferences.length > 0 && (
          <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim, #888)', lineHeight: 1.5 }}>
              Use the intended account reference when explicitly adopting an automation in the agent&apos;s Control UI.
            </div>
            {a.profileReferences.map((profile) => (
              <div key={profile.id} style={{ display: 'grid', gap: 4 }}>
                <div style={{ fontSize: 11, color: 'var(--text-dim, #888)', overflowWrap: 'anywhere' }}>
                  {profile.email ?? accountLabel}{profile.plan ? ` · ${profile.plan}` : ''}
                  {profile.expiresAt ? ` · expires ${formatDate(profile.expiresAt)}` : ''}
                </div>
                <Input readOnly value={profile.id} aria-label={`Account reference ${profile.id}`} />
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        {claude ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {rowCopy && claude.action !== 'none' && (
              <Button
                type="button" variant="primary" size="sm"
                loading={!!connecting}
                disabled={busy || !a.running || !!a.error}
                onClick={onConnect}
              >
                {connecting ? rowCopy.connecting : claude.action === 'reconnect' ? rowCopy.reconnect : rowCopy.connect}
              </Button>
            )}
            {rowCopy && claude.disconnect && (
              <Button
                type="button" variant="danger" size="sm"
                loading={disconnecting}
                disabled={busy || !a.running}
                onClick={() => onDisconnect(a)}
              >
                {disconnecting ? rowCopy.disconnecting : rowCopy.disconnect}
              </Button>
            )}
          </div>
        ) : a.connected ? (
          <Button
            type="button" variant="danger" size="sm"
            loading={disconnecting}
            disabled={busy || !a.running}
            onClick={() => onDisconnect(a)}
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        ) : (
          <Button
            type="button" variant="primary" size="sm"
            disabled={busy || !a.running || !!a.error}
            onClick={onConnect}
          >
            Connect
          </Button>
        )}
      </div>
    </div>
  );
}

function ConnectModal({ provider, copy, agentId, agentName, onClose, onConnected }: {
  provider: SubscriptionProvider;
  copy: SubscriptionProviderCopy;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onConnected: (email: string | null) => void;
}) {
  const [login, setLogin] = useState<Login | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  // The server no longer knows the job (the dashboard restarted while the dialog was open).
  const [lost, setLost] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  const announcedRef = useRef(false);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    setLost(false);
    setLogin(null);
    try {
      const json = await readJson<{ login: Login }>(await fetch(provider.loginPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      }));
      setLogin(json.login);
    } catch (e) {
      setStartError((e as Error).message);
    }
    setStarting(false);
  }, [agentId, provider.loginPath]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  const active = !lost && !!login && (login.state === 'starting' || login.state === 'waiting');

  // Poll the job every 2 s while it runs; a newer request cancels the one still in flight.
  useEffect(() => {
    if (!active) return;
    const tick = async () => {
      pollRef.current?.abort();
      const controller = new AbortController();
      pollRef.current = controller;
      try {
        const res = await fetch(`${provider.loginPath}?agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.login) setLogin(json.login as Login);
        else if (res.ok && json.login === null) setLost(true);
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') { /* the next tick retries */ }
      }
    };
    const t = setInterval(() => { void tick(); }, 2000);
    return () => { clearInterval(t); pollRef.current?.abort(); };
  }, [active, agentId, provider.loginPath]);

  useEffect(() => {
    if (login?.state !== 'waiting') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [login?.state]);

  useEffect(() => {
    if (login?.state === 'connected' && !announcedRef.current) {
      announcedRef.current = true;
      onConnected(login.email);
    }
  }, [login, onConnected]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await fetch(`${provider.loginPath}?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    } catch { /* the in-container timeout is the backstop */ }
    setCancelling(false);
    onClose();
  };

  const close = () => { if (cancelling || starting) return; if (active) void cancel(); else onClose(); };

  const copyCode = async () => {
    if (!login?.code) return;
    try {
      await navigator.clipboard.writeText(login.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the code is on screen to copy by hand */ }
  };

  const remaining = login?.expiresAt ? Math.max(0, Math.floor((login.expiresAt - now) / 1000)) : null;
  const mmss = remaining === null ? '' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  const failedState = startError || lost || (login && (login.state === 'failed' || login.state === 'expired' || login.state === 'cancelled'));

  return (
    <Modal open onClose={close} title={copy.connectTitle(agentName)} maxWidth={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
        {(starting || login?.state === 'starting') && !startError && (
          <div style={{ color: 'var(--text-dim, #888)' }}>Waiting for the agent…</div>
        )}

        {!lost && login?.state === 'waiting' && (
          <>
            <div>
              1. Open{' '}
              <a href={login.url ?? '#'} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--violet)' }}>
                {login.url}
              </a>
            </div>
            <div>
              <div style={{ marginBottom: 6 }}>2. Enter this code:</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 28, fontFamily: 'monospace', letterSpacing: '0.12em', fontWeight: 700 }}>{login.code}</span>
                <Button type="button" variant="secondary" size="sm" onClick={() => { void copyCode(); }}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>
              {copy.codeHint}
              {remaining !== null && <> Time left: <strong>{mmss}</strong>.</>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>{copy.waiting}</div>
          </>
        )}

        {!lost && login?.state === 'connected' && (
          <div style={{ color: 'var(--green)' }}>Connected{login.email ? ` as ${login.email}` : ''}.</div>
        )}

        {failedState && (
          <div style={{ color: !lost && login?.state === 'cancelled' ? 'var(--text-dim, #888)' : 'var(--red)' }}>
            {startError ?? (lost ? 'The login was interrupted. Start again.' : null) ?? login?.error ?? (login?.state === 'cancelled' ? 'Cancelled.' : 'The login did not complete.')}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {failedState && (
            <Button type="button" variant="primary" size="sm" loading={starting} disabled={starting} onClick={() => { void start(); }}>
              {starting ? 'Starting…' : lost ? 'Start again' : 'Retry'}
            </Button>
          )}
          {active ? (
            <Button type="button" variant="secondary" size="sm" loading={cancelling} disabled={cancelling} onClick={() => { void cancel(); }}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="sm" disabled={starting} onClick={onClose}>
              {login?.state === 'connected' ? 'Done' : 'Close'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
