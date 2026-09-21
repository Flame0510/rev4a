'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ConfirmModal, Input, LoadingSpinner, Metric, ModalityIcons, Page, PageHeader, Pill, Surface } from '../components/ui';
import PasswordInput from '../components/PasswordInput';
import { Skeleton } from '../components/Skeleton';
import { useModels } from '../lib/models-context';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */
interface ModelInfo {
  id: string;
  name: string;
  enabled: boolean;
  /** USD per 1M tokens. -1/-1 means the model routes dynamically. */
  pricing?: { input: number; output: number };
  /** Set when the price came from the live OpenRouter catalogue, not the static file. */
  pricingLive?: boolean;
  /** e.g. "text+image+file->text" — curated, matches what sync.ts provisions. */
  modality?: string;
}

interface GatewayProvider {
  provider: string;
  label: string;
  configured: boolean;
  baseUrl: string;
  docsUrl: string;
  models: ModelInfo[];
  apiKey?: string;
}

interface ProviderApiResponse {
  providers: GatewayProvider[];
}

/* ------------------------------------------------------------------ */
/*  Overlay Loader Component                                          */
/* ------------------------------------------------------------------ */
function LoadingOverlay({ message }: { message: string }) {
  return <LoadingSpinner label={message} />;
}

/* ------------------------------------------------------------------ */
/*  Component (main)                                                  */
/* ------------------------------------------------------------------ */
/** The sync part of a provider-route response. */
interface SyncOutcomeView { ok: boolean; summary: string }

/**
 * Message for a change that was saved, given how far the sync got.
 *
 * The save and its propagation are separate outcomes. Every handler here used to
 * check only `status === 'ok'` and ignore `sync`, so a key or toggle saved while
 * Docker was stopped read as a complete success — one said "Agent sync complete"
 * unconditionally.
 */
function savedMessage(saved: string, sync: SyncOutcomeView | undefined): { type: 'success' | 'warning'; text: string } {
  if (!sync) return { type: 'success', text: saved };
  if (sync.ok) return { type: 'success', text: `${saved} ${sync.summary}` };
  return { type: 'warning', text: `${saved} ${sync.summary} Run Sync All Agents once the cause is fixed.` };
}

export default function GatewayPageClient() {
  // This page is the only thing that changes which models are on offer, so it is
  // the only thing that has to tell the rest of the app to re-read them. Without
  // this the chat panel's select kept the old list for the whole session.
  const { refresh: refreshOfferedModels } = useModels();
  const [providers, setProviders] = useState<GatewayProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Overlay loader
  const [overlay, setOverlay] = useState<{ active: boolean; message: string }>({ active: false, message: '' });

  // Show skeleton inline instead of blocking whole page
  const skeletonRows = loading;

  // API key form state
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [originalKeys, setOriginalKeys] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, { type: 'success' | 'error' | 'warning'; text: string } | null>>({});
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string | null>>({});
  const [revealing, setRevealing] = useState<Record<string, boolean>>({});

  // Per-provider model filter (purely local, no requests)
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({});

  // Balance fetch state (per provider)
  const [balances, setBalances] = useState<Record<string, { balance: string; label?: string; loading?: boolean; error?: string; unsupported?: boolean } | null>>({});
  const [fetchingBalance, setFetchingBalance] = useState<Record<string, boolean>>({});

  // Accordion state — which provider cards are expanded
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const expandedInitRef = useRef(false);

  /* ---- Data loading ---- */
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const provRes = await fetch('/api/gateway/provider');
      if (provRes.ok) {
        const provJson: ProviderApiResponse = await provRes.json();
        setProviders(provJson.providers);

        // Auto-expand configured providers on first load
        if (!expandedInitRef.current) {
          expandedInitRef.current = true;
          const configured = new Set<string>();
          provJson.providers.forEach((p: any) => {
            if (p.configured) configured.add(p.provider);
          });
          if (configured.size > 0) setExpandedProviders(configured);
        }
        // Load keys from provider response (all configured providers now return apiKey)
        const keyEntries: Record<string, string> = {};
        const origEntries: Record<string, string> = {};
        provJson.providers.forEach((p: any) => {
          if (p.configured && p.apiKey) {
            keyEntries[p.provider] = p.apiKey;
            origEntries[p.provider] = p.apiKey;
          }
        });
        setApiKeyInputs((prev) => ({ ...prev, ...keyEntries }));
        setOriginalKeys((prev) => ({ ...prev, ...origEntries }));

        // Auto-fetch balances for supported providers that have keys configured
        const balanceProvs = provJson.providers
          .filter((p: any) => p.configured && ['deepseek','openrouter','glm'].includes(p.provider))
          .map((p: any) => p.provider);
        for (const bp of balanceProvs) {
          try {
            const bRes = await fetch(`/api/gateway/provider/balance?provider=${bp}`);
            const bJson = await bRes.json();
            if (bRes.ok && bJson.balance) {
              setBalances((prev) => ({ ...prev, [bp]: { balance: bJson.balance, label: bJson.label } }));
            } else if (bJson.reason === 'no-balance-api') {
              // Permanent: this provider has no balance API for the account — hide the badge.
              setBalances((prev) => ({ ...prev, [bp]: { balance: '', unsupported: true } }));
            } else {
              setBalances((prev) => ({ ...prev, [bp]: { balance: '—', error: bJson.error || 'Failed' } }));
            }
          } catch (e: unknown) {
            setBalances((prev) => ({ ...prev, [bp]: { balance: '—', error: e instanceof Error ? e.message : String(e) } }));
          }
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  /** Format pricing for display: "$0.44 / $0.87" or "Free" or "Dynamic" or "—" */
  function fmtPrice(p: { input: number; output: number } | null | undefined): string {
    if (!p) return '—';
    if (p.input === -1 && p.output === -1) return 'Dynamic';
    if (p.input === 0 && p.output === 0) return 'Free';
    const f = (n: number) => n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
    return `${f(p.input)} / ${f(p.output)}`;
  }

  /**
   * Local model filter. Matches against both the display name and the id,
   * because the upstream vendor often only appears in one of them — e.g.
   * "Kimi K2 (OR)" has id `openrouter/moonshotai/kimi-k2`, so searching
   * either "kimi" or "moonshot" has to find it.
   *
   * Every whitespace-separated term must match somewhere, so "kimi code"
   * narrows rather than widening.
   */
  function filterModels<T extends { id: string; name: string }>(models: T[], query: string): T[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return models;
    return models.filter((m) => {
      const haystack = `${m.name} ${m.id}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }

  /* ---- Overlay helper ---- */
  async function withOverlay<T>(message: string, fn: () => Promise<T>): Promise<T> {
    setOverlay({ active: true, message });
    try {
      return await fn();
    } finally {
      setOverlay({ active: false, message: '' });
    }
  }

  /* ---- Balance fetch ---- */
  async function fetchBalance(provider: string) {
    setFetchingBalance((prev) => ({ ...prev, [provider]: true }));
    setBalances((prev) => ({ ...prev, [provider]: null }));
    try {
      const res = await fetch(`/api/gateway/provider/balance?provider=${provider}`);
      const json = await res.json();
      if (res.ok && json.balance) {
        setBalances((prev) => ({ ...prev, [provider]: { balance: json.balance, label: json.label } }));
      } else if (json.reason === 'no-balance-api') {
        setBalances((prev) => ({ ...prev, [provider]: { balance: '', unsupported: true } }));
      } else {
        setBalances((prev) => ({ ...prev, [provider]: { balance: '—', error: json.error || 'Failed' } }));
      }
    } catch (e: unknown) {
      setBalances((prev) => ({ ...prev, [provider]: { balance: '—', error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setFetchingBalance((prev) => ({ ...prev, [provider]: false }));
    }
  }

  /* ---- Save / Remove API key ---- */
  async function handleSave(provider: string) {
    const key = apiKeyInputs[provider]?.trim();
    if (!key) return;
    await withOverlay(`Saving API key for ${provider}…`, async () => {
      setMessages((prev) => ({ ...prev, [provider]: null }));
      try {
        const res = await fetch('/api/gateway/provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: key }),
        });
        const json = await res.json();
        if (json.status === 'ok') {
          setMessages((prev) => ({ ...prev, [provider]: savedMessage('API key saved.', json.sync) }));
          setOriginalKeys((prev) => ({ ...prev, [provider]: key }));
          setProviders((prev) => prev.map((p) => p.provider === provider ? { ...p, configured: true } : p));
          refreshOfferedModels(); // a new key can make models available
          await loadAll();
        } else {
          setMessages((prev) => ({ ...prev, [provider]: { type: 'error', text: json.error || 'Error' } }));
        }
      } catch (e: unknown) {
        setMessages((prev) => ({ ...prev, [provider]: { type: 'error', text: e instanceof Error ? e.message : 'Network error' } }));
      }
    });
  }

  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);

  async function handleRemove(provider: string) {
    setRemoveConfirm(provider);
  }

  async function executeRemove() {
    const provider = removeConfirm;
    if (!provider) return;
    setRemoveConfirm(null);
    await withOverlay(`Removing API key ${provider}…`, async () => {
      setMessages((prev) => ({ ...prev, [provider]: null }));
      try {
        const res = await fetch('/api/gateway/provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        });
        const json = await res.json();
        if (json.status === 'ok') {
          setMessages((prev) => ({ ...prev, [provider]: savedMessage('API key removed.', json.sync) }));
          setProviders((prev) => prev.map((p) => p.provider === provider ? { ...p, configured: false } : p));
          refreshOfferedModels(); // its models are no longer offered
          await loadAll();
        } else {
          setMessages((prev) => ({ ...prev, [provider]: { type: 'error', text: json.error || 'Error' } }));
        }
      } catch (e: unknown) {
        setMessages((prev) => ({ ...prev, [provider]: { type: 'error', text: e instanceof Error ? e.message : 'Network error' } }));
      }
    });
  }

  /* ---- Save Rev4a API Key ---- */
  async function handleSaveRev4aKey() {
    const key = apiKeyInputs['rev4a']?.trim();
    if (!key) return;
    await withOverlay('Saving REV4A API KEY…', async () => {
      setMessages((prev) => ({ ...prev, rev4a: null }));
      try {
        const res = await fetch('/api/gateway/provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'rev4a', apiKey: key }),
        });
        const json = await res.json();
        if (json.status === 'ok') {
          setMessages((prev) => ({ ...prev, rev4a: savedMessage('REV4A API KEY saved.', json.sync) }));
          setOriginalKeys((prev) => ({ ...prev, rev4a: key }));
          await loadAll();
        } else {
          setMessages((prev) => ({ ...prev, rev4a: { type: 'error', text: json.error || 'Error' } }));
        }
      } catch (e: unknown) {
        setMessages((prev) => ({ ...prev, rev4a: { type: 'error', text: e instanceof Error ? e.message : 'Network error' } }));
      }
    });
  }

  /* ---- Toggle model ---- */
  async function handleToggleModel(modelId: string, enabled: boolean) {
    await withOverlay(`${enabled ? 'Enable' : 'Disable'} model…`, async () => {
      setMessages((prev) => ({ ...prev, [`model-${modelId}`]: null }));
      try {
        const res = await fetch('/api/gateway/provider', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, enabled }),
        });
        const json = await res.json();
        if (json.status === 'ok') {
          // Update local state only — no full reload
          setProviders((prev) =>
            prev.map((p) => ({
              ...p,
              models: p.models.map((m) =>
                m.id === modelId ? { ...m, enabled } : m
              ),
            })),
          );
          refreshOfferedModels();
          if (json.sync && !json.sync.ok) {
            setMessages((prev) => ({ ...prev, [`model-${modelId}`]: savedMessage(`${enabled ? 'Enabled' : 'Disabled'}.`, json.sync) }));
          }
        } else {
          setMessages((prev) => ({ ...prev, [`model-${modelId}`]: { type: 'error', text: json.error || 'Error' } }));
        }
      } catch (e: unknown) {
        setMessages((prev) => ({ ...prev, [`model-${modelId}`]: { type: 'error', text: e instanceof Error ? e.message : 'Network error' } }));
      }
    });
  }

  /* ---- Helpers ---- */
  const configuredCount = providers.filter((p) => p.configured && p.provider !== 'rev4a').length;
  const rev4aKeyConfigured = providers.find((p) => p.provider === 'rev4a')?.configured ?? false;
  const allEnabledModels = providers
    .filter((p) => p.configured)
    .flatMap((p) =>
    p.models.filter((m) => m.enabled).map((m) => ({ ...m, providerLabel: p.label })),
  );

  /* ---- Loading state ---- */
  if (loading && providers.length === 0 && !error) {
    return (
      <Page maxWidth={1000}>
        <PageHeader eyebrow="" title="Gateway" description="Loading…" />
        <div style={{ display: 'grid', gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <Surface key={i}>
              <Skeleton width="60%" height={14} style={{ marginBottom: 10 }} />
              <Skeleton width="80%" height={20} />
            </Surface>
          ))}
        </div>
      </Page>
    );
  }

  if (error && providers.length === 0) {
    return (
      <Page maxWidth={1000}>
        <PageHeader eyebrow="" title="Gateway" description="Error" />
        <Surface variant="panel" tone="danger">
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>{error}</div>
        </Surface>
      </Page>
    );
  }

  return (
    <Page maxWidth={1000}>
      {/* Overlay loader */}
      {overlay.active && <LoadingOverlay message={overlay.message} />}

      <PageHeader
        eyebrow=""
        title="Gateway"
        description="Providers and the model catalogue. API keys are stored in .env."
      />

      {/* Sync all agents — propagate provider baseUrl + models to every container */}
      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            setOverlay({ active: true, message: 'Syncing all agents…' });
            try {
              const res = await fetch('/api/gateway/provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _syncOnly: true }) });
              const data = await res.json();
              setOverlay({ active: false, message: '' });
              if (data.status === 'ok') {
                setMessages((prev) => ({ ...prev, refresh: { type: 'success', text: data.sync?.summary ?? 'Synced.' } }));
                refreshOfferedModels();
              } else {
                setMessages((prev) => ({ ...prev, refresh: { type: 'error', text: data.error || data.sync?.summary || 'Sync failed' } }));
              }
            } catch (e: unknown) {
              setOverlay({ active: false, message: '' });
              setMessages((prev) => ({ ...prev, refresh: { type: 'error', text: e instanceof Error ? e.message : 'Sync failed' } }));
            }
          }}
        >
          ↻ Sync All Agents
        </Button>
        {messages.refresh && (
          <span style={{ fontSize: 11, color: messages.refresh.type === 'success' ? '#34d399' : messages.refresh.type === 'warning' ? 'var(--yellow)' : '#ef4444' }}>
            {messages.refresh.text}
          </span>
        )}
      </div>

      {/* Metrics */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        {skeletonRows ? (
          <>
            <Skeleton height={72} style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
            <Skeleton height={72} style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
          </>
        ) : (
          <>
            <Metric title="Configured providers" value={`${configuredCount} / ${providers.filter((p) => p.provider !== 'rev4a').length}`} subtitle="DeepSeek, OpenRouter, Codex, …" tone={configuredCount > 0 ? 'success' : 'warning'} />
            <Metric title="Active models" value={allEnabledModels.length} subtitle="for all configured providers" tone={allEnabledModels.length > 0 ? 'success' : 'warning'} />
          </>
        )}
      </section>

      {/* =========================================================== */}
      {/*  REV4A API KEY — sezione speciale                         */}
      {/* =========================================================== */}
      <div style={{ marginBottom: 20 }}>
      <Surface variant="panel">
        <div style={{ padding: '16px 18px', display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: rev4aKeyConfigured ? 'var(--green)' : 'var(--gray)',
              flexShrink: 0,
            }} />
            <div style={{ fontWeight: 600, fontSize: 14 }}>REV4A API KEY</div>
            {rev4aKeyConfigured ? <Pill tone="success">Configured</Pill> : <Pill tone="warning">Not configured</Pill>}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <PasswordInput
              value={apiKeyInputs['rev4a'] ?? ''}
              onChange={(v) => setApiKeyInputs((prev) => ({ ...prev, rev4a: v }))}
              placeholder="REV4A_API_KEY"
              style={{ flex: 1, minWidth: 200 }}
              showGenerate
            />
            <Button variant="primary" size="sm"
              loading={overlay.active}
              disabled={apiKeyInputs['rev4a']?.trim() === originalKeys['rev4a']?.trim()}
              onClick={() => handleSaveRev4aKey()}>
              Save
            </Button>

            {messages['rev4a'] && (
              <div style={{
                flex: '1 1 100%', padding: '6px 10px', borderRadius: 0,
                fontSize: 12, fontWeight: 500,
                background: messages['rev4a']!.type === 'success' ? 'rgba(var(--green-rgb,34,197,94),0.1)' : messages['rev4a']!.type === 'warning' ? 'rgba(245,158,11,0.1)' : 'rgba(var(--red-rgb,239,68,68),0.1)',
                color: messages['rev4a']!.type === 'success' ? 'var(--green)' : messages['rev4a']!.type === 'warning' ? 'var(--yellow)' : 'var(--red)',
              }}>
                {messages['rev4a']!.text}
              </div>
            )}
          </div>
        </div>
      </Surface>
      </div>

      {/* Providers */}
      <section style={{ display: 'grid', gap: 16 }}>
        {providers.filter((p) => p.provider !== 'rev4a').map((p) => {
          const enabledCount = p.models.filter((m) => m.enabled).length;
          const msg = messages[p.provider];
          const isExpanded = expandedProviders.has(p.provider);

          const toggleExpanded = () => {
            setExpandedProviders((prev) => {
              const next = new Set(prev);
              if (next.has(p.provider)) next.delete(p.provider);
              else next.add(p.provider);
              return next;
            });
          };

          return (
            <Surface key={p.provider} variant="panel">
              {/* Accordion header — always visible, clickable */}
              <div
                onClick={toggleExpanded}
                style={{
                  padding: '12px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                {/* Expand/collapse arrow */}
                <span style={{
                  fontSize: 10,
                  color: 'var(--text-dim)',
                  transition: 'transform 0.15s',
                  transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  minWidth: 12,
                  textAlign: 'center',
                }}>
                  ▶
                </span>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.configured ? 'var(--green)' : 'var(--gray)', flexShrink: 0 }} />
                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.label}</div>
                {p.configured ? <Pill tone="success">Connected</Pill> : <Pill tone="warning">Not configured</Pill>}
                {enabledCount > 0 ? <Pill tone="accent">{enabledCount} active models</Pill> : <Pill>{enabledCount} active models</Pill>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
                  {p.models.length} models
                </span>
                {/* Balance badge — auto-loaded for supported providers with configured key.
                    Same squared chip in every state: "..." while loading, "—" (dimmed, tooltip) on error.
                    Hidden entirely when the provider has no balance API for the account (permanent). */}
                {p.configured && ['deepseek','openrouter','glm'].includes(p.provider) && !balances[p.provider]?.unsupported && (
                  <button
                    type="button"
                    title={balances[p.provider]?.error || balances[p.provider]?.label || ''}
                    onClick={(e) => { e.stopPropagation(); fetchBalance(p.provider); }}
                    style={{
                      fontSize: 11, fontWeight: 600,
                      color: 'var(--green)',
                      background: 'rgba(var(--green-rgb,34,197,94),0.1)',
                      padding: '2px 8px', borderRadius: 0,
                      border: '1px solid rgba(var(--green-rgb,34,197,94),0.2)',
                      cursor: 'pointer',
                      opacity: balances[p.provider]?.error ? 0.5 : 1,
                    }}
                  >
                    {balances[p.provider] && !balances[p.provider]?.error ? balances[p.provider]!.balance : balances[p.provider]?.error ? '—' : '...'}
                  </button>
                )}
              </div>

              {/* Accordion body — expandable */}
              {isExpanded && (
                <div style={{ padding: '0 18px 16px 18px', display: 'grid', gap: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  {/* API Key input with an inline show/hide toggle */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <PasswordInput
                      value={apiKeyInputs[p.provider] ?? ''}
                      onChange={(v) => setApiKeyInputs((prev) => ({ ...prev, [p.provider]: v }))}
                      placeholder={`API Key ${p.label}`}
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <Button variant="primary" size="sm"
                      loading={overlay.active}
                      disabled={apiKeyInputs[p.provider]?.trim() === originalKeys[p.provider]?.trim()}
                      onClick={() => handleSave(p.provider)}>
                      Save
                    </Button>
                    {p.configured && (
                      <Button variant="danger" size="sm" disabled={overlay.active} onClick={() => handleRemove(p.provider)}>
                        Remove
                      </Button>
                    )}
                  </div>

                  {p.baseUrl && (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                      Endpoint: <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 0 }}>{p.baseUrl}</code>
                      {' • '}<a href={p.docsUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--violet)' }}>Get key ↗</a>
                    </div>
                  )}

                  {/* Models with checkboxes */}
                  {p.models.length > 0 && (() => {
                    const query = modelSearch[p.provider] || '';
                    const visibleModels = filterModels(p.models, query);
                    // Below this many, everything fits on screen and a
                    // search box is just noise.
                    const showSearch = p.models.length > 6;
                    return (
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          Models
                          <span style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 'normal', color: 'var(--violet)', opacity: 0.7, fontSize: 10 }}>
                            in / out per 1M tokens
                          </span>
                        </div>
                        {query && (
                          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                            {visibleModels.length} of {p.models.length}
                          </span>
                        )}
                      </div>

                      {showSearch && (
                        <div style={{ marginBottom: 8 }}>
                          {/* Deliberately type="text": Safari clears type="search"
                              on Escape via a `search` event React never sees,
                              leaving an empty box over a still-filtered list. */}
                          <Input
                            type="text"
                            value={query}
                            placeholder="Filter by name or provider — e.g. kimi, moonshot, flash"
                            aria-label={`Filter ${p.label} models`}
                            onChange={(e) => setModelSearch((prev) => ({ ...prev, [p.provider]: e.target.value }))}
                          />
                        </div>
                      )}

                      <div style={{ display: 'grid', gap: 4, maxHeight: 360, overflowY: 'auto' }}>
                        {visibleModels.length === 0 && (
                          <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '8px 4px' }}>
                            No model matches “{query}”.
                          </div>
                        )}
                        {visibleModels.map((m) => {
                          const modelMsg = messages[`model-${m.id}`];
                          const pricing = m.pricing;
                          // -1/-1 is OpenRouter's marker for router models,
                          // whose price and capabilities both vary per call.
                          const isDynamic = pricing?.input === -1 && pricing?.output === -1;
                          return (
                            // Only the name/id are inside the <label>: clicking
                            // anywhere in a label toggles its checkbox, and the
                            // badges below carry tooltips people will click to
                            // read — which would silently flip the model and
                            // restart every agent container.
                            <div key={m.id} style={{
                              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '5px 8px',
                              background: m.enabled ? 'rgba(var(--green-rgb,34,197,94),0.06)' : 'transparent',
                              fontSize: 12,
                            }}>
                              <input type="checkbox" checked={m.enabled} disabled={overlay.active}
                                id={`model-${m.id}`}
                                onChange={(e) => handleToggleModel(m.id, e.target.checked)}
                                style={{ accentColor: 'var(--green)', cursor: 'pointer' }} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <label
                                    htmlFor={`model-${m.id}`}
                                    style={{ fontWeight: m.enabled ? 500 : 400, cursor: overlay.active ? 'wait' : 'pointer' }}
                                  >
                                    {m.name}
                                  </label>
                                  <ModalityIcons modality={m.modality} dynamic={isDynamic} />
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'monospace' }}>
                                  {m.id}
                                  <span style={{ marginLeft: 8, color: 'var(--violet)', fontWeight: 500 }}>
                                    {fmtPrice(pricing)}
                                  </span>
                                  {m.pricingLive && (
                                    <span
                                      title="Live price from the OpenRouter API"
                                      style={{ marginLeft: 6, display: 'inline-block', verticalAlign: 'middle' }}
                                    >
                                      <Pill tone="success">LIVE</Pill>
                                    </span>
                                  )}
                                </div>
                              </div>
                              {modelMsg && (
                                // Its own full-width line under the name, not a third column. As an
                                // unconstrained flex item a long sync summary took its natural width
                                // and crushed the name/id column to a few pixels. Indented past the
                                // checkbox so it reads as belonging to this model.
                                <div style={{
                                  flexBasis: '100%', paddingLeft: 23, fontSize: 11, lineHeight: 1.45,
                                  overflowWrap: 'anywhere',
                                  color: modelMsg.type === 'success' ? 'var(--green)' : modelMsg.type === 'warning' ? 'var(--yellow)' : 'var(--red)',
                                }}>
                                  {modelMsg.text}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    );
                  })()}

                  {msg && (
                    <div className={`msg-${msg.type}`}>
                      {msg.text}
                    </div>
                  )}
                </div>
              )}
            </Surface>
          );
        })}
      </section>
      <ConfirmModal
        open={removeConfirm !== null}
        onClose={() => setRemoveConfirm(null)}
        onConfirm={executeRemove}
        title="Remove API Key"
        message={`Remove API key for ${removeConfirm || ''}?`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        tone="danger"
      />
    </Page>
  );
}
