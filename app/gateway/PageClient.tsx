'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ConfirmModal, LoadingSpinner, Metric, Page, PageHeader, Pill, Surface, Tabs, type Tone } from '../components/ui';
import PasswordInput from '../components/PasswordInput';
import { Skeleton } from '../components/Skeleton';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */
type Tab = 'providers' | 'agents';

interface ModelInfo {
  id: string;
  name: string;
  enabled: boolean;
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

interface GatewayAgent {
  agentId: string;
  containerName: string;
  state: string;
  defaultModel: string;
  fallbacks: string[];
}

interface GatewayData {
  timestamp: number;
  gateway: string;
  status: string;
  agents: { total: number; list: GatewayAgent[] };
  apiKeys: { configured: string[]; all: { provider: string; configured: boolean }[] };
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
/*  FallbackSelector — pick one or more fallback models from list    */
/* ------------------------------------------------------------------ */
function FallbackSelector({
  availableModels,
  selected,
  onChange,
}: {
  availableModels: { id: string; name: string; providerLabel: string }[];
  selected: string[];
  onChange: (models: string[]) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const toggleModel = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={() => setIsOpen(!isOpen)}
        style={{
          cursor: 'pointer',
          padding: '8px 10px',
          borderRadius: 0,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          fontSize: 12,
          minHeight: 36,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          alignItems: 'center',
        }}
      >
        {selected.length === 0 && (
          <span style={{ color: 'var(--text-dim)' }}>No fallbacks</span>
        )}
        {selected.map((id) => {
          const m = availableModels.find((a) => a.id === id);
          return (
            <span
              key={id}
              onClick={(e) => {
                e.stopPropagation();
                toggleModel(id);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 0,
                background: 'rgba(167,139,250,0.14)',
                border: '1px solid rgba(167,139,250,0.24)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {m?.name || id}
              <span style={{ marginLeft: 2, opacity: 0.6 }}>✕</span>
            </span>
          );
        })}
        <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 'auto' }}>▼</span>
      </div>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 100,
            marginTop: 4,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 0,
            maxHeight: 220,
            overflowY: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {availableModels.map((m) => {
            const isSel = selected.includes(m.id);
            return (
              <div
                key={m.id}
                onClick={() => toggleModel(m.id)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: isSel ? 'rgba(var(--green-rgb,34,197,94),0.06)' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={isSel}
                  readOnly
                  style={{ accentColor: 'var(--green)', pointerEvents: 'none' }}
                />
                <div>
                  <div style={{ fontWeight: isSel ? 500 : 400 }}>{m.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'monospace' }}>{m.id}</div>
                </div>
              </div>
            );
          })}
          {availableModels.length === 0 && (
            <div style={{ padding: '12px', color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>
              No models available
            </div>
          )}
        </div>
      )}

      {isOpen && (
        <div
          onClick={() => setIsOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 99 }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentEditForm — select + fallback pills (inline)                  */
/* ------------------------------------------------------------------ */
function AgentEditForm({
  agentId,
  allModels,
  initialModel,
  initialFallbacks,
  saving,
  onSave,
  onCancel,
}: {
  agentId: string;
  allModels: { id: string; name: string; providerLabel: string }[];
  initialModel: string;
  initialFallbacks: string;
  saving: boolean;
  onSave: (model: string, fallbacks: string[]) => void;
  onCancel: () => void;
}) {
  const [modelInput, setModelInput] = useState(initialModel || '');
  const [fallbacks, setFallbacks] = useState<string[]>(
    [...new Set(initialFallbacks ? initialFallbacks.split(',').map((s) => s.trim()).filter(Boolean) : [])],
  );
  const fallbackCandidates = allModels.filter((m) => m.id !== modelInput);

  const toggleFallback = (id: string) => {
    setFallbacks((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]);
  };

  return (
    <div style={{ display: 'grid', gap: 10, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Update model for <strong>{agentId}</strong>.
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {/* Primary model — styled native select */}
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>Primary model</div>
          <select
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--bg3)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 0,
              fontSize: 11,
              padding: '6px 28px 6px 8px',
              fontFamily: 'var(--font-mono-stack)',
              cursor: 'pointer',
              outline: 'none',
              WebkitAppearance: 'none',
              MozAppearance: 'none',
              appearance: 'none',
              backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12'><path fill='%238a8a92' d='M6 8L1 3h10z'/></svg>\")",
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 8px center',
            }}
          >
            <option value="" disabled>Select model…</option>
            {allModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.providerLabel}
              </option>
            ))}
          </select>
        </div>

        {/* Fallback pills selector */}
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>Fallback</div>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            padding: 4,
            minHeight: 36,
            borderRadius: 0,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
          }}>
            {fallbackCandidates.length === 0 ? (
              <span style={{ color: 'var(--text-dim)', fontSize: 11, padding: '6px 4px' }}>No models available</span>
            ) : fallbacks.length === 0 ? (
              <span style={{ color: 'var(--text-dim)', fontSize: 11, padding: '6px 4px' }}>Click a model to add as fallback</span>
            ) : null}
            {fallbackCandidates.map((m) => {
              const isSelected = fallbacks.includes(m.id);
              return (
                <span
                  key={m.id}
                  onClick={() => toggleFallback(m.id)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    padding: '3px 8px',
                    borderRadius: 0,
                    fontSize: 11,
                    cursor: 'pointer',
                    background: isSelected
                      ? 'rgba(167,139,250,0.18)'
                      : 'rgba(255,255,255,0.05)',
                    border: isSelected
                      ? '1px solid rgba(167,139,250,0.35)'
                      : '1px solid rgba(255,255,255,0.1)',
                    transition: 'all 0.12s',
                  }}
                >
                  {m.name}
                  {isSelected && <span style={{ marginLeft: 2, opacity: 0.6 }}>✕</span>}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" size="sm" loading={saving} disabled={!modelInput.trim()} onClick={() => onSave(modelInput, fallbacks)}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component (main)                                                  */
/* ------------------------------------------------------------------ */
export default function GatewayPageClient() {
  const [tab, setTab] = useState<Tab>('providers');
  const [gatewayData, setGatewayData] = useState<GatewayData | null>(null);
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
  const [messages, setMessages] = useState<Record<string, { type: 'success' | 'error'; text: string } | null>>({});
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string | null>>({});
  const [revealing, setRevealing] = useState<Record<string, boolean>>({});

  // Agent edit state
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [agentModelInput, setAgentModelInput] = useState('');
  const [agentFallbackInput, setAgentFallbackInput] = useState('');

  // Balance fetch state (per provider)
  const [balances, setBalances] = useState<Record<string, { balance: string; label?: string; loading?: boolean; error?: string } | null>>({});
  const [fetchingBalance, setFetchingBalance] = useState<Record<string, boolean>>({});

  // Accordion state — which provider cards are expanded
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const expandedInitRef = useRef(false);

  /* ---- Data loading ---- */
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [provRes, gwRes] = await Promise.all([
        fetch('/api/gateway/provider'),
        fetch('/api/gateway'),
      ]);
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
            } else {
              setBalances((prev) => ({ ...prev, [bp]: { balance: '—', error: bJson.error || 'Failed' } }));
            }
          } catch (e: unknown) {
            setBalances((prev) => ({ ...prev, [bp]: { balance: '—', error: e instanceof Error ? e.message : String(e) } }));
          }
        }
      }
      if (gwRes.ok) {
        const gwJson: GatewayData = await gwRes.json();
        setGatewayData(gwJson);
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
          setMessages((prev) => ({ ...prev, [provider]: { type: 'success', text: 'API key saved.' } }));
          setOriginalKeys((prev) => ({ ...prev, [provider]: key }));
          setProviders((prev) => prev.map((p) => p.provider === provider ? { ...p, configured: true } : p));
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
          setMessages((prev) => ({ ...prev, [provider]: { type: 'success', text: 'API key removed.' } }));
          setProviders((prev) => prev.map((p) => p.provider === provider ? { ...p, configured: false } : p));
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
          setMessages((prev) => ({ ...prev, rev4a: { type: 'success', text: 'REV4A API KEY saved. Agent sync complete.' } }));
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
        } else {
          setMessages((prev) => ({ ...prev, [`model-${modelId}`]: { type: 'error', text: json.error || 'Error' } }));
        }
      } catch (e: unknown) {
        setMessages((prev) => ({ ...prev, [`model-${modelId}`]: { type: 'error', text: e instanceof Error ? e.message : 'Network error' } }));
      }
    });
  }

  /* ---- Agent model update ---- */
  async function handleUpdateAgent(key: string, model?: string, fallbacksFromForm?: string[]) {
    if (!model && !agentModelInput.trim()) return;
    const modelValue = model || agentModelInput.trim();
    const fallbacksValue = fallbacksFromForm || (agentFallbackInput.trim()
      ? agentFallbackInput.split(',').map((s) => s.trim()).filter(Boolean)
      : []);

    // Resolve container name from agentId or containerName
    const agent = gatewayData?.agents?.list?.find(
      (a) => a.containerName === key || a.agentId === key,
    );
    const containerName = agent?.containerName || key;

    // Overlay: only during the PUT call
    setOverlay({ active: true, message: 'Updating model…' });
    try {
      const res = await fetch('/api/gateway/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containerName, model: modelValue, fallbacks: fallbacksValue }),
      });
      const json = await res.json();
      setOverlay({ active: false, message: '' });

      if (json.status === 'ok') {
        setMessages((prev) => ({ ...prev, [`agent-${key}`]: { type: 'success', text: 'Restarting gateway…' } }));
        setEditingAgent(null);
        setAgentModelInput('');
        setAgentFallbackInput('');
        // Poll in background: GET /api/gateway every second until it responds
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const gwRes = await fetch('/api/gateway');
            if (gwRes.ok) {
              const gwJson: GatewayData = await gwRes.json();
              setGatewayData(gwJson);
              break;
            }
          } catch { /* retry */ }
        }
        // Clear the message
        setMessages((prev) => ({ ...prev, [`agent-${key}`]: null }));
      } else {
        setMessages((prev) => ({ ...prev, [`agent-${key}`]: { type: 'error', text: json.error || 'Error' } }));
      }
    } catch (e: unknown) {
      setOverlay({ active: false, message: '' });
      setMessages((prev) => ({ ...prev, [`agent-${key}`]: { type: 'error', text: e instanceof Error ? e.message : 'Network error' } }));
    }
  }

  /* ---- Helpers ---- */
  const configuredCount = providers.filter((p) => p.configured && p.provider !== 'rev4a').length;
  const rev4aKeyConfigured = providers.find((p) => p.provider === 'rev4a')?.configured ?? false;
  const agentCount = gatewayData?.agents?.total ?? 0;
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
        description="Provider, models and agents. API keys are stored in .env."
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
                setMessages((prev) => ({ ...prev, refresh: { type: 'success', text: `Synced ${data.sync?.length ?? 0} agent(s)` } }));
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
          <span style={{ fontSize: 11, color: messages.refresh.type === 'success' ? '#34d399' : '#ef4444' }}>
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
            <Skeleton height={72} style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
          </>
        ) : (
          <>
            <Metric title="Configured providers" value={`${configuredCount} / ${providers.filter((p) => p.provider !== 'rev4a').length}`} subtitle="DeepSeek, OpenRouter, Codex, …" tone={configuredCount > 0 ? 'success' : 'warning'} />
            <Metric title="Active models" value={allEnabledModels.length} subtitle="for all configured providers" tone={allEnabledModels.length > 0 ? 'success' : 'warning'} />
            <Metric title="Agents" value={agentCount} subtitle="with AGENT_ID label" tone={agentCount > 0 ? 'success' : 'warning'} />
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
                background: messages['rev4a']!.type === 'success' ? 'rgba(var(--green-rgb,34,197,94),0.1)' : 'rgba(var(--red-rgb,239,68,68),0.1)',
                color: messages['rev4a']!.type === 'success' ? 'var(--green)' : 'var(--red)',
              }}>
                {messages['rev4a']!.text}
              </div>
            )}
          </div>
        </div>
      </Surface>
      </div>

      {/* Tabs */}
      <Tabs
        items={[
          {
            label: 'Provider',
            active: tab === 'providers',
            onClick: () => setTab('providers'),
            count: `${configuredCount}/${providers.filter(p => p.provider !== 'rev4a').length}`,
          },
          {
            label: 'Agents',
            active: tab === 'agents',
            onClick: () => setTab('agents'),
            count: agentCount,
          },
        ]}
      />

      {/* =========================================================== */}
      {/* TAB: PROVIDERS                                               */}
      {/* =========================================================== */}
      {tab === 'providers' && (
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
                  {/* Balance badge — auto-loaded for supported providers with configured key */}
                  {p.configured && ['deepseek','openrouter','glm'].includes(p.provider) && (
                    balances[p.provider] && !balances[p.provider]?.error ? (
                      <span
                        title={balances[p.provider]?.label || ''}
                        onClick={(e) => { e.stopPropagation(); fetchBalance(p.provider); }}
                        style={{
                          fontSize: 11, fontWeight: 600,
                          color: 'var(--green)',
                          background: 'rgba(var(--green-rgb,34,197,94),0.1)',
                          padding: '2px 8px', borderRadius: 0,
                          border: '1px solid rgba(var(--green-rgb,34,197,94),0.2)',
                          cursor: 'pointer',
                        }}
                      >
                        {balances[p.provider]!.balance}
                      </span>
                    ) : (
                      <span
                        onClick={(e) => { e.stopPropagation(); fetchBalance(p.provider); }}
                        style={{
                          fontSize: 11,
                          color: 'var(--text-dim)',
                          opacity: 0.5,
                          cursor: 'pointer',
                        }}
                      >
                        {fetchingBalance[p.provider] ? '…' : '…'}
                      </span>
                    )
                  )}
                </div>

                {/* Accordion body — expandable */}
                {isExpanded && (
                  <div style={{ padding: '0 18px 16px 18px', display: 'grid', gap: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                    {/* API Key input con show/hide integrato */}
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
                    {p.models.length > 0 && (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          Models
                          <span style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 'normal', color: 'var(--violet)', opacity: 0.7, fontSize: 10 }}>
                            in / out per 1M tokens
                          </span>
                        </div>
                        <div style={{ display: 'grid', gap: 4, maxHeight: 360, overflowY: 'auto' }}>
                          {p.models.map((m) => {
                            const modelMsg = messages[`model-${m.id}`];
                            return (
                              <label key={m.id} style={{
                                display: 'flex', alignItems: 'center', gap: 10, padding: '5px 8px', borderRadius: 0,
                                background: m.enabled ? 'rgba(var(--green-rgb,34,197,94),0.06)' : 'transparent',
                                cursor: overlay.active ? 'wait' : 'pointer', fontSize: 12,
                              }}>
                                <input type="checkbox" checked={m.enabled} disabled={overlay.active}
                                  onChange={(e) => handleToggleModel(m.id, e.target.checked)}
                                  style={{ accentColor: 'var(--green)', cursor: 'pointer' }} />
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontWeight: m.enabled ? 500 : 400 }}>{m.name}</div>
                                  <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'monospace' }}>
                                    {m.id}
                                    <span style={{ marginLeft: 8, color: 'var(--violet)', fontWeight: 500 }}>
                                      {fmtPrice((m as any).pricing)}
                                    </span>
                                  </div>
                                </div>
                                {modelMsg && (
                                  <span style={{ fontSize: 11, color: modelMsg.type === 'success' ? 'var(--green)' : 'var(--red)' }}>
                                    {modelMsg.text}
                                  </span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {msg && (
                      <div className={msg.type === 'success' ? 'msg-success' : 'msg-error'}>
                        {msg.text}
                      </div>
                    )}
                  </div>
                )}
              </Surface>
            );
          })}
        </section>
      )}

      {/* =========================================================== */}
      {/* TAB: AGENTS                                                  */}
      {/* =========================================================== */}
      {tab === 'agents' && (
        <section>
          {allEnabledModels.length > 0 && (
            <div style={{ marginBottom: 16 }}><Surface variant="panel">
              <div style={{ padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Models available for agents ({allEnabledModels.length})
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {allEnabledModels.map((m) => {
                    const tone: Tone | undefined = m.providerLabel === 'Rev4a Aliases' ? 'accent' : undefined;
                    return <Pill key={m.id} tone={tone}>{m.id} <span style={{ opacity: 0.5 }}>({m.providerLabel})</span></Pill>;
                  })}
                </div>
              </div>
            </Surface></div>
          )}

          {(!gatewayData?.agents?.list || gatewayData.agents.list.length === 0) ? (
            <Surface variant="panel">
              <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 13, color: 'var(--text-dim)' }}>
                No agents found. Start a container with the <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 0 }}>AGENT_ID</code> label.
              </div>
            </Surface>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              {gatewayData.agents.list.map((agent) => {
                const key = agent.agentId || agent.containerName;
                const msg = messages[`agent-${key}`];
                const isEditing = editingAgent === key;
                return (
                  <Surface key={key} variant="panel">
                    <div style={{ padding: '16px 18px', display: 'grid', gap: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <div className={'gateway-agent-dot' + (agent.state === 'running' ? ' gateway-agent-dot--ok' : ' gateway-agent-dot--err')} />
                        <div style={{ fontWeight: 600 }}>{agent.agentId}</div>
                        <Pill tone={agent.state === 'running' ? 'success' : 'danger'}>{agent.state}</Pill>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 12 }}>
                        <span style={{ color: 'var(--text-dim)' }}>Primary model:</span>
                        <span style={{ fontWeight: 500 }}>{agent.defaultModel || '—'}</span>
                        <span style={{ color: 'var(--text-dim)' }}>Fallback:</span>
                        <span style={{ fontWeight: 500 }}>{agent.fallbacks.length > 0 ? agent.fallbacks.join(', ') : '—'}</span>
                      </div>
                      {isEditing ? (
                        <AgentEditForm
                          agentId={agent.agentId}
                          allModels={allEnabledModels}
                          initialModel={agent.defaultModel}
                          initialFallbacks={agent.fallbacks.join(', ')}
                          saving={overlay.active}
                          onSave={(model, fallbacks) => handleUpdateAgent(key, model, fallbacks)}
                          onCancel={() => setEditingAgent(null)}
                        />
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => { setEditingAgent(key); setAgentModelInput(agent.defaultModel || ''); setAgentFallbackInput(agent.fallbacks.join(', ')); }}>
                          ✏️ Change model
                        </Button>
                      )}
                      {msg && (
                        <div className={msg.type === 'success' ? 'msg-success' : 'msg-error'}>
                          {msg.text}
                        </div>
                      )}
                    </div>
                  </Surface>
                );
              })}
            </div>
          )}
        </section>
      )}
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
