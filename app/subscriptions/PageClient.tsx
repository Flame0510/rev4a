'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Accordion, Button, ConfirmModal, Modal, Page, PageHeader, Pill, showToast } from '@/app/components/ui';
import { Skeleton } from '@/app/components/Skeleton';
import UsageBlock from './UsageBlock';
import {
  SUBSCRIPTIONS_DESCRIPTION,
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
  usesSubscription: boolean;
  primary: string | null;
  fallbacks: string[];
  error: string | null;
}
interface Job { agentId: string; kind: 'logout'; state: 'running' | 'done' | 'failed'; error: string | null }
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
interface Models { list: SubModel[]; error: string | null; loading: boolean }

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

const POLL_MS = 1500;
const POLL_BACKOFF_MAX_MS = 15000;
const POLL_GIVE_UP_MS = 2 * 60 * 1000;
const EMPTY_ROW: Row = { status: null, loading: true, error: null, job: null, notice: null };
const PROVIDER_ID = 'openai';
const PROVIDER_NAME = 'ChatGPT (Codex)';

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
const ownModelName = (a: { primary: string | null; fallbacks: string[] }): string => {
  const own = a.fallbacks.find((f) => !f.startsWith('openai/')) ?? (a.primary && !a.primary.startsWith('openai/') ? a.primary : null);
  return own ? bare(own) : 'its own model';
};
const modelName = (id: string) => (id.startsWith('rev4a/') ? id.slice('rev4a/'.length) : id.replace(/^openai\//, ''));
const JOB_PATH = '/api/subscriptions/openai/logout';

export default function SubscriptionsPageClient() {
  const [agents, setAgents] = useState<ListAgent[] | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [models, setModels] = useState<Models>({ list: [], error: null, loading: true });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ [PROVIDER_ID]: true });
  const [connectAgent, setConnectAgent] = useState<string | null>(null);
  /** The agent whose disconnect awaits the operator's confirmation. */
  const [confirmDisconnect, setConfirmDisconnect] = useState<SubAgent | null>(null);

  // One AbortController per row for its status read, one per row for its job poll: a newer
  // request cancels the one still in flight (AGENTS.md §2.2b rule 9).
  const rowAbort = useRef(new Map<string, AbortController>());
  const pollAbort = useRef(new Map<string, AbortController>());
  const pollTimer = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const modelsAbort = useRef<AbortController | null>(null);
  const listAbort = useRef<AbortController | null>(null);
  // Agents with an action being started: guards a double click before React commits the disabled buttons.
  const starting = useRef(new Set<string>());
  const alive = useRef(true);

  const patchRow = useCallback((agentId: string, patch: Partial<Row>) => {
    setRows((r) => ({ ...r, [agentId]: { ...(r[agentId] ?? EMPTY_ROW), ...patch } }));
  }, []);

  const loadModels = useCallback(async () => {
    modelsAbort.current?.abort();
    const controller = new AbortController();
    modelsAbort.current = controller;
    setModels((m) => ({ ...m, loading: true }));
    try {
      const json = await readJson<{ models: SubModel[]; error: string | null }>(
        await fetch('/api/subscriptions/models', { signal: controller.signal }),
      );
      setModels({ list: json.models ?? [], error: json.error ?? null, loading: false });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      setModels({ list: [], error: 'Could not read the models.', loading: false });
    }
  }, []);

  const stopPoll = useCallback((agentId: string) => {
    pollAbort.current.get(agentId)?.abort();
    pollAbort.current.delete(agentId);
    const t = pollTimer.current.get(agentId);
    if (t) clearTimeout(t);
    pollTimer.current.delete(agentId);
  }, []);

  // `loadRow` and `pollJob` call each other (a finished job refreshes its row; a row that
  // reads a running job polls it), so they are reached through a ref.
  const api = useRef<{ loadRow: (id: string) => Promise<void>; pollJob: (id: string) => void }>({
    loadRow: async () => {},
    pollJob: () => {},
  });

  api.current.loadRow = async (agentId: string) => {
    rowAbort.current.get(agentId)?.abort();
    const controller = new AbortController();
    rowAbort.current.set(agentId, controller);
    patchRow(agentId, { loading: true });
    try {
      const json = await readJson<{ agent: SubAgent; action: Job | null }>(
        await fetch(`/api/subscriptions?agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal }),
      );
      const running = json.action?.state === 'running' ? json.action : null;
      patchRow(agentId, { status: json.agent, loading: false, error: null, job: running });
      if (running) api.current.pollJob(agentId);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      patchRow(agentId, { loading: false, error: (e as Error).message || 'Could not read this agent.' });
    }
  };

  api.current.pollJob = (agentId: string) => {
    stopPoll(agentId);
    let failingSince: number | null = null;
    let delay = POLL_MS;
    const tick = async () => {
      if (!alive.current) return;
      const controller = new AbortController();
      pollAbort.current.set(agentId, controller);
      let job: Job | null | undefined;
      try {
        const json = await readJson<{ job: Job | null }>(
          await fetch(`${JOB_PATH}?agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal }),
        );
        job = json.job;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        job = undefined; // a failed poll: try again, backing off
      }
      if (job === undefined) {
        failingSince ??= Date.now();
        if (Date.now() - failingSince >= POLL_GIVE_UP_MS) {
          pollAbort.current.delete(agentId);
          pollTimer.current.delete(agentId);
          patchRow(agentId, { job: null, loading: false, error: 'Lost track of the disconnect. Refresh the row.' });
          return;
        }
        pollTimer.current.set(agentId, setTimeout(() => { void tick(); }, delay));
        delay = Math.min(delay * 2, POLL_BACKOFF_MAX_MS);
        return;
      }
      failingSince = null;
      delay = POLL_MS;
      if (job && job.state === 'running') {
        pollTimer.current.set(agentId, setTimeout(() => { void tick(); }, POLL_MS));
        return;
      }
      pollAbort.current.delete(agentId);
      pollTimer.current.delete(agentId);
      // Done, failed, or no longer known (the dashboard restarted): read the row again.
      patchRow(agentId, { job: null, notice: job?.state === 'failed' ? (job.error ?? 'The change failed.') : null });
      if (job?.state === 'done') showToast('Disconnected', 'success');
      await api.current.loadRow(agentId);
      void loadModels();
    };
    pollTimer.current.set(agentId, setTimeout(() => { void tick(); }, POLL_MS));
  };

  const loadAll = useCallback(async () => {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    void loadModels();
    try {
      const json = await readJson<{ providers: { id: string; agents: ListAgent[] }[] }>(
        await fetch('/api/subscriptions', { signal: controller.signal }),
      );
      const list = json.providers.find((p) => p.id === PROVIDER_ID)?.agents ?? [];
      setAgents(list);
      setError(null);
      // Every row loads its own status, in parallel.
      for (const a of list) {
        if (!a.running) {
          setRows((r) => ({ ...r, [a.agentId]: { status: { ...a, connected: false, email: null, plan: null, expiresAt: null, usesSubscription: false, primary: null, fallbacks: [], error: null }, loading: false, error: null, job: null, notice: null } }));
        } else {
          setRows((r) => ({ ...r, [a.agentId]: r[a.agentId] ?? EMPTY_ROW }));
          void api.current.loadRow(a.agentId);
        }
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      setError((e as Error).message || 'Could not load subscriptions');
      setAgents((a) => a ?? []);
    }
  }, [loadModels]);

  useEffect(() => {
    alive.current = true;
    void loadAll();
    const rowAborts = rowAbort.current;
    const pollAborts = pollAbort.current;
    const timers = pollTimer.current;
    return () => {
      alive.current = false;
      listAbort.current?.abort();
      modelsAbort.current?.abort();
      rowAborts.forEach((c) => c.abort());
      pollAborts.forEach((c) => c.abort());
      timers.forEach((t) => clearTimeout(t));
    };
  }, [loadAll]);

  const disconnect = async (agent: SubAgent) => {
    if (starting.current.has(agent.agentId)) return;
    starting.current.add(agent.agentId);
    patchRow(agent.agentId, { job: { agentId: agent.agentId, kind: 'logout', state: 'running', error: null }, notice: null });
    try {
      await readJson<{ job: Job }>(await fetch(JOB_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.agentId }),
      }));
      api.current.pollJob(agent.agentId);
    } catch (e) {
      patchRow(agent.agentId, { job: null, notice: (e as Error).message });
    }
    starting.current.delete(agent.agentId);
  };

  if (agents === null) {
    return (
      <Page maxWidth={1080}>
        <PageHeader eyebrow="" title="Subscriptions" description={SUBSCRIPTIONS_DESCRIPTION} />
        <SubscriptionsBodySkeleton />
      </Page>
    );
  }

  const statuses = agents.map((a) => rows[a.agentId]?.status).filter((s): s is SubAgent => !!s);
  const allLoaded = agents.every((a) => rows[a.agentId] && !rows[a.agentId].loading);
  const connected = statuses.filter((s) => s.connected);
  const accounts = [...new Map(connected.filter((s) => s.email).map((s) => [s.email as string, s.plan])).entries()];
  const sampleFallback = statuses.find((s) => s.usesSubscription && s.fallbacks.find((f) => !f.startsWith('openai/')));
  const usageEmails = allLoaded ? [...new Set(connected.map((s) => s.email).filter((e): e is string => !!e))].sort() : [];
  const connectName = agents.find((a) => a.agentId === connectAgent)?.name ?? connectAgent ?? '';

  return (
    <Page maxWidth={1080}>
      <PageHeader eyebrow="" title="Subscriptions" description={SUBSCRIPTIONS_DESCRIPTION} />

      {error && (
        <div style={{ padding: '10px 14px', background: 'var(--bg2)', border: '1px solid var(--red)', color: 'var(--red)', fontSize: 12, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        <Accordion
          id={`sub-${PROVIDER_ID}`}
          open={!!open[PROVIDER_ID]}
          onToggle={() => setOpen((o) => ({ ...o, [PROVIDER_ID]: !o[PROVIDER_ID] }))}
          title={PROVIDER_NAME}
          summary={allLoaded ? `${connected.length} of ${agents.length} agents connected` : <Skeleton as="span" inline width={140} height={12} />}
          detail={accounts.length ? accounts.map(([email, plan]) => (plan ? `${email} (${plan})` : email)).join(', ') : undefined}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' }}>
            <UsageBlock
              emails={usageEmails}
              fallbackName={sampleFallback ? bare(sampleFallback.fallbacks.find((f) => !f.startsWith('openai/')) as string) : null}
            />

            <div>
              {models.loading && models.list.length === 0 ? (
                <SubscriptionsModelsSkeleton />
              ) : (
                <>
                  <div style={{ fontSize: 10, color: 'var(--text-dim, #888)', letterSpacing: '0.06em', marginBottom: 6 }}>MODELS</div>
                  {models.list.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>
                      {models.error ?? 'Connect an agent to see the models your account offers.'}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {models.list.map((m) => (
                        <span key={m.key} style={{ fontSize: 12, border: '1px solid var(--border)', padding: '4px 8px' }}>
                          {m.name}
                          {m.contextWindow ? <span style={{ color: 'var(--text-dim, #888)' }}> · {formatContext(m.contextWindow)}</span> : null}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              {agents.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>No agents yet.</div>}
              {agents.map((a) => (
                <AgentRow
                  key={a.agentId}
                  agent={a}
                  row={rows[a.agentId] ?? EMPTY_ROW}
                  onConnect={() => setConnectAgent(a.agentId)}
                  onRetry={() => { void api.current.loadRow(a.agentId); }}
                  onDisconnect={(s) => setConfirmDisconnect(s)}
                />
              ))}
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-dim, #888)', lineHeight: 1.5 }}>
              When the subscription reaches its usage limit the agent falls back to its own model
              {sampleFallback ? ` (${bare(sampleFallback.fallbacks.find((f) => !f.startsWith('openai/')) as string)})` : ''}.
              The limit is shared with your own use of Codex on the same account.
            </div>
          </div>
        </Accordion>
      </div>

      <ConfirmModal
        open={!!confirmDisconnect}
        onClose={() => setConfirmDisconnect(null)}
        onConfirm={() => {
          const target = confirmDisconnect;
          setConfirmDisconnect(null);
          if (target) void disconnect(target);
        }}
        title="Disconnect agent"
        message={confirmDisconnect
          ? `Disconnect ${confirmDisconnect.name}? It goes back to ${ownModelName(confirmDisconnect)} and signs out of ChatGPT. Connecting again needs a new code.`
          : ''}
        confirmLabel="Disconnect"
      />

      {connectAgent && (
        <ConnectModal
          agentId={connectAgent}
          agentName={connectName}
          onClose={() => {
            const id = connectAgent;
            setConnectAgent(null);
            void api.current.loadRow(id);
            void loadModels();
          }}
          onConnected={(email) => { showToast(`${connectName} connected${email ? ` as ${email}` : ''}`, 'success'); }}
        />
      )}
    </Page>
  );
}

function AgentRow({ agent, row, onConnect, onRetry, onDisconnect }: {
  agent: ListAgent;
  row: Row;
  onConnect: () => void;
  onRetry: () => void;
  onDisconnect: (s: SubAgent) => void;
}) {
  const a = row.status;
  const running = row.job?.state === 'running' ? row.job : null;
  const secondary = agent.container !== agent.name ? agent.container : null;

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
  if (!a.running) { tone = 'neutral'; status = 'Stopped'; }
  else if (a.error) { tone = 'danger'; status = 'Error'; }
  else if (a.connected) { tone = 'success'; status = a.expiresAt ? `Connected until ${formatDate(a.expiresAt)}` : 'Connected'; }

  const busy = !!running || row.loading;
  const disconnecting = !!running;

  return (
    <div style={{ border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        {head}
        <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Pill tone={tone}>{status}</Pill>
          {a.connected && a.email && (
            <span style={{ fontSize: 11, color: 'var(--text-dim, #888)' }}>{a.email}{a.plan ? ` · ${a.plan}` : ''}</span>
          )}
        </div>
        {a.error && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{a.error}</div>}
        {row.error && (
          <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--red)' }}>{row.error} The status above may be out of date.</span>
            <Button type="button" variant="secondary" size="sm" disabled={row.loading} loading={row.loading} onClick={onRetry}>Retry</Button>
          </div>
        )}
        {row.notice && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{row.notice}</div>}
        {!a.running && <div style={{ fontSize: 11, color: 'var(--text-dim, #888)', marginTop: 4 }}>Stopped, status unknown. Start the agent to connect it.</div>}
        {a.running && a.connected && a.primary && (
          <div style={{ fontSize: 11, color: 'var(--text-dim, #888)', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span>
              Model: {modelName(a.primary)}
              {a.fallbacks[0] ? ` · fallback ${modelName(a.fallbacks[0])}` : ''}
            </span>
            <Link href={`/agents?agent=${encodeURIComponent(agent.agentId)}`} style={{ color: 'var(--violet)' }}>Change in the agent panel</Link>
          </div>
        )}
      </div>
      <div>
        {a.connected ? (
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

function ConnectModal({ agentId, agentName, onClose, onConnected }: {
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
      const json = await readJson<{ login: Login }>(await fetch('/api/subscriptions/openai/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      }));
      setLogin(json.login);
    } catch (e) {
      setStartError((e as Error).message);
    }
    setStarting(false);
  }, [agentId]);

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
        const res = await fetch(`/api/subscriptions/openai/login?agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.login) setLogin(json.login as Login);
        else if (res.ok && json.login === null) setLost(true);
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') { /* the next tick retries */ }
      }
    };
    const t = setInterval(() => { void tick(); }, 2000);
    return () => { clearInterval(t); pollRef.current?.abort(); };
  }, [active, agentId]);

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
      await fetch(`/api/subscriptions/openai/login?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    } catch { /* the in-container timeout is the backstop */ }
    setCancelling(false);
    onClose();
  };

  const close = () => { if (cancelling || starting) return; if (active) void cancel(); else onClose(); };

  const copy = async () => {
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
    <Modal open onClose={close} title={`Connect ChatGPT to ${agentName}`} maxWidth={480}>
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
                <Button type="button" variant="secondary" size="sm" onClick={() => { void copy(); }}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>
              Enter this code on OpenAI with your ChatGPT account. It expires in 15 minutes.
              {remaining !== null && <> Time left: <strong>{mmss}</strong>.</>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>Waiting for you to finish on OpenAI…</div>
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
