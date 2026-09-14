'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { SkeletonLines } from '../components/Skeleton';
import { Button, ListItem, Badge, ConfirmModal, Input, type Tone } from '../components/ui';
import PasswordInput from '../components/PasswordInput';
import ImageDownloadBanner from './ImageDownloadBanner';
import ChannelManager from './ChannelManager';
import ModelSection from './ModelSection';
import {
  InfoIcon, BracesIcon, KeyIcon, TrashIcon, TerminalIcon,
  LinkIcon, ArchiveIcon, RotateIcon, PackageIcon,
} from '../components/Icons';

/** Section header with an identifying icon. `danger` switches to the red palette. */
function SectionHeader({ icon, label, danger = false }: { icon: React.ReactNode; label: string; danger?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '8px 14px',
      borderBottom: `1px solid ${danger ? 'rgba(239,68,68,0.15)' : 'var(--border)'}`,
      color: danger ? '#ef4444' : 'var(--violet)',
      fontSize: 10, letterSpacing: '0.08em',
    }}>
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
      {label}
    </div>
  );
}

interface Agent {
  id: string;
  agentId: string;
  name: string;
  displayName?: string;
  image: string;
  imageTag: string;
  template: string | null;
  status: string;
  state: string;
  ports: string;
  ip: string | null;
  created: string | null;
  env: string[];
  controlPort: string | null;
  authToken: string | null;
  imageOutdated?: boolean;
}

/**
 * URL of the agent's OpenClaw Control UI.
 *
 * Composed here rather than on the server on purpose. The hostname the dashboard
 * is currently being reached on is, by definition, one that resolves and routes
 * for this user — `localhost` on a dev machine, a LAN address from a phone, the
 * VPS IP, or a domain. The server can only guess, and it guessed badly: it shelled
 * out to `curl icanhazip.com` on every call and, on macOS, ended up returning the
 * machine's `.local` mDNS name.
 *
 * Returns null when the agent has no published port (nothing to link to) or when
 * called during a server render, where `window` doesn't exist.
 */
function agentControlUrl(agent: Agent): string | null {
  if (!agent.controlPort || typeof window === 'undefined') return null;
  const base = `http://${window.location.hostname}:${agent.controlPort}`;
  return agent.authToken ? `${base}#token=${encodeURIComponent(agent.authToken)}` : base;
}

type FilterState = 'all' | 'running' | 'exited';

const STATUS_BULLET: Record<string, string> = {
  running: '#22c55e',
  exited: '#ef4444',
  paused: '#f59e0b',
  restarting: '#3b82f6',
};

function fmtCreated(created: string | null): string {
  if (!created) return '-';
  const ms = Date.now() - new Date(created).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** ToggleSwitch - compact on/off toggle for container lifecycle */
function ToggleSwitch({ checked, disabled, onChange, ariaLabel }: { checked: boolean; disabled?: boolean; onChange: () => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      aria-label={ariaLabel}
      aria-pressed={checked}
      className={`toggle-switch${checked ? ' toggle-switch--on' : ''}`}
      style={{
        position: 'relative',
        width: 38,
        height: 22,
        borderRadius: 11,
        border: '1px solid var(--border)',
        background: checked ? 'var(--violet)' : 'var(--bg)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s ease, border-color 0.15s ease',
        flexShrink: 0,
        opacity: disabled ? 0.4 : 1,
        padding: 0,
        outline: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: checked ? '#fff' : '#888',
          transition: 'left 0.15s ease, background 0.15s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}
      />
    </button>
  );
}

/** NoProviderBanner - shown when no provider API keys are configured */
function NoProviderBanner() {
  return (
    <div style={{
      padding: '10px 14px',
      background: 'rgba(251,191,36,0.08)',
      borderBottom: '1px solid rgba(251,191,36,0.2)',
      fontSize: 12,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexShrink: 0,
      flexWrap: 'wrap',
      gap: 8,
    }}>
      <div>
        <strong style={{ color: '#fbbf24' }}>⚠ No providers configured.</strong>
        {' '}Agents need model providers to run. Configure them in the&nbsp;
        <a href="/gateway" style={{ color: 'var(--violet)', textDecoration: 'underline' }}>
          Gateway
        </a>.
      </div>
      <a
        href="/gateway"
        style={{
          padding: '4px 10px',
          border: '1px solid var(--violet)',
          color: 'var(--violet)',
          fontSize: 11,
          textDecoration: 'none',
          background: 'transparent',
          whiteSpace: 'nowrap',
        }}
      >
        Open Gateway →
      </a>
    </div>
  );
}


/** Shared agent list-item used in both mobile and desktop views. */
function AgentListItem({
  agent,
  loading,
  selected,
  channelSummary,
  modelSummary,
  onClick,
  onLifecycle,
}: {
  agent: Agent;
  loading: boolean;
  selected?: boolean;
  channelSummary: Record<string, { telegram: boolean }>;
  modelSummary: Record<string, { primary: string | null; health: string; fallbackCount: number; firstFallback?: string | null }>;
  onClick: () => void;
  onLifecycle: () => void;
}) {
  return (
    <ListItem onClick={onClick} active={selected} style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ToggleSwitch
          checked={agent.state === 'running'}
          disabled={loading || agent.state === 'unknown'}
          onChange={() => { void onLifecycle(); }}
          ariaLabel={agent.state === 'running' ? 'Stop container' : 'Start container'}
        />
        <span style={{ color: selected ? 'var(--violet)' : 'var(--text)', fontSize: 13, fontWeight: 500 }}>{agent.displayName || agent.name}</span>
        {agent.template && (
          <span style={{ fontSize: 10, background: 'rgba(146,91,252,0.12)', color: 'var(--violet)', padding: '1px 6px', borderRadius: 0, border: '1px solid rgba(146,91,252,0.25)' }}>{agent.template}</span>
        )}
        <div style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          {loading && <span style={{ fontSize: 10, color: '#888' }}>...</span>}
          {agent.state === 'running' && agent.controlPort && (
            <Button
              variant="primary"
              size="sm"
              // Gate on the port, resolve the URL on click: the condition stays
              // safe to evaluate during a server render, the URL never is.
              onClick={(e) => {
                e.stopPropagation();
                const url = agentControlUrl(agent);
                if (url) window.open(url, '_blank');
              }}
              title="Open agent Control UI"
            >
              Open ↗
            </Button>
          )}
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
        {agent.image?.includes('/') ? agent.image.split('/').pop() : agent.image}
        {agent.ports && <span style={{ marginLeft: 8 }}>{agent.ports}</span>}
      </div>
      {(() => {
        const m = modelSummary[agent.agentId];
        if (!m || !m.primary) return null;
        // Tone follows what the operator has to do about it: red means the agent
        // will fail on its next turn, amber means it still works on a retired name.
        // The red states differ in remedy — pick another model for the first two,
        // run Sync All on the Gateway page for OUT OF SYNC.
        const failing = m.health === 'missing' || m.health === 'disabled' || m.health === 'out-of-sync';
        const tone = failing ? 'danger' : m.health === 'deprecated' ? 'warning' : undefined;
        const chip = m.health === 'missing' ? 'NOT IN CATALOGUE'
                   : m.health === 'disabled' ? 'NOT ENABLED'
                   : m.health === 'out-of-sync' ? 'OUT OF SYNC'
                   : m.health === 'deprecated' ? 'DEPRECATED'
                   : m.fallbackCount === 0 ? 'NO FALLBACK' : null;
        return (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#888', wordBreak: 'break-all' }}>
              {m.primary.replace(/^rev4a\//, '')}
              {/* Only the first fallback: a list here would drown the row, and the
                  full set is editable in the detail panel anyway. */}
              {m.firstFallback && (
                <span style={{ color: '#666' }}>
                  {' ↳ '}{m.firstFallback.replace(/^rev4a\//, '')}
                  {m.fallbackCount > 1 && ` +${m.fallbackCount - 1}`}
                </span>
              )}
            </span>
            {chip && (
              <Badge tone={(tone ?? 'neutral') as Tone}>
                <span style={{ fontSize: 8, padding: '1px 6px' }}>{chip}</span>
              </Badge>
            )}
          </div>
        );
      })()}
      {channelSummary[agent.agentId]?.telegram && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <Badge tone="success"><span style={{ fontSize: 8, padding: '1px 6px' }}>TG</span></Badge>
        </div>
      )}
      {agent.imageOutdated && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <Badge tone="warning"><span style={{ fontSize: 8, padding: '1px 6px' }}>OUTDATED</span></Badge>
        </div>
      )}
    </ListItem>
  );
}

export default function AgentsPageClient() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<FilterState>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [showList, setShowList] = useState(true);
  const [chSummary, setChSummary] = useState<Record<string, { telegram: boolean }>>({});
  const [mdSummary, setMdSummary] = useState<Record<string, { primary: string | null; health: string; fallbackCount: number; firstFallback?: string | null }>>({});
  const [imageReady, setImageReady] = useState(true);
  // null = not checked yet. Keeping "unknown" distinct from "none configured" is
  // the whole point: `false` as the initial value makes an unanswered check look
  // exactly like a negative answer, so the warning banner renders on no evidence.
  const [providersConfigured, setProvidersConfigured] = useState<boolean | null>(null);
  const [gatewayToken, setGatewayToken] = useState('');
  const [tokenLoading, setTokenLoading] = useState(true);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenStatus, setTokenStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState<string | null>(null);
  const skipNextPoll = useRef(false);
  /** Guards the un-awaited channel-summary fetch against out-of-order responses. */
  const chSummarySeq = useRef(0);
  const mdSummarySeq = useRef(0);

  /**
   * Refresh the per-agent model rows that feed the card chips.
   *
   * Shared by the 15s poll and by a save in the detail panel: without the second
   * caller the chip kept showing the previous model until the next poll, which
   * reads as "the save did not work".
   *
   * Sequence-guarded because several can overlap; the last one issued wins.
   */
  const refreshModelSummary = useCallback(async () => {
    const seq = ++mdSummarySeq.current;
    try {
      const res = await fetch('/api/agents/models-summary');
      if (!res.ok || seq !== mdSummarySeq.current) return;
      const payload = await res.json();
      const byId: Record<string, { primary: string | null; health: string; fallbackCount: number; firstFallback?: string | null }> = {};
      for (const row of payload.agents ?? []) byId[row.agentId] = row;
      setMdSummary(byId);
    } catch { /* badges are optional */ }
  }, []);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Invalid response');
      setAgents(data);
      setError('');

      // Channel summary is deliberately not awaited: it only decorates rows with
      // a TG badge, and awaiting it here held the whole page behind a second
      // round trip — the agent list was ready in ~0.25s but stayed hidden for
      // ~1.15s. It now lands on its own and the badges appear when it does.
      //
      // Sequence-guarded: load() also runs on a 15s poll, so several of these can
      // be in flight at once. Without the check, a slow earlier response landing
      // after a faster later one would overwrite fresh badges with stale ones.
      const seq = ++chSummarySeq.current;
      void (async () => {
        try {
          const chRes = await fetch('/api/agents/channels-summary');
          if (!chRes.ok || seq !== chSummarySeq.current) return;
          setChSummary(await chRes.json());
        } catch { /* badges are optional */ }
      })();

      // Same treatment for the model summary: it decorates rows, so it must not
      // hold the list, and a slow earlier response must not overwrite a newer one.
      void refreshModelSummary();
    } catch (e: any) {
      setError(e.message || 'Loading error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const i = setInterval(() => {
      if (skipNextPoll.current) { skipNextPoll.current = false; return; }
      load();
    }, 15000);
    return () => clearInterval(i);
  }, [load]);

  // Check if agent base image exists (needed for creating agents)
  useEffect(() => {
    fetch('/api/agents/image-status')
      .then((r) => r.json())
      .then((d: { exists: boolean }) => setImageReady(d.exists))
      .catch(() => setImageReady(false));
  }, []);

  // Check if any provider is configured in the Gateway
  useEffect(() => {
    // summary=1: skips the live-pricing round trip we don't need here.
    fetch('/api/gateway/provider?summary=1')
      .then((r) => r.json())
      .then((d: { providers?: Array<{ configured: boolean }> }) =>
        setProvidersConfigured((d.providers || []).some((p) => p.configured))
      )
      .catch(() => setProvidersConfigured(false));
  }, []);

  // Load gateway token
  const loadToken = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/token');
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      setGatewayToken(typeof data.token === 'string' ? data.token : '');
    } catch {
      // token not available
    } finally {
      setTokenLoading(false);
    }
  }, []);

  useEffect(() => { loadToken(); }, [loadToken]);

  // Auto-clear token status after 4 seconds
  useEffect(() => {
    if (!tokenStatus) return;
    const t = setTimeout(() => setTokenStatus(null), 4000);
    return () => clearTimeout(t);
  }, [tokenStatus]);

  const handleImageReady = useCallback(() => {
    setImageReady(true);
  }, []);

  const handleLifecycle = useCallback(async (agent: Agent) => {
    const action = agent.state === 'running' ? 'stop' : 'start';
    setLifecycleLoading(agent.agentId);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.agentId)}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error(`Lifecycle ${action} failed:`, data.error || res.statusText);
      }
      // Refresh agent list to pick up new state; skip the next polling cycle
      skipNextPoll.current = true;
      await load();
    } catch (e: unknown) {
      console.error(`Lifecycle request failed:`, (e as Error).message);
    } finally {
      setLifecycleLoading(null);
    }
  }, [load]);

  async function saveToken() {
    setTokenSaving(true);
    setTokenStatus(null);
    try {
      const res = await fetch('/api/agents/token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: gatewayToken }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Save failed');
      setTokenStatus({ type: 'success', message: `Saved and synced to ${data.containersUpdated} container(s)` });
    } catch (e: any) {
      setTokenStatus({ type: 'error', message: e.message || 'Save failed' });
    } finally {
      setTokenSaving(false);
    }
  }

  const filtered = useMemo(() => {
    let list = [...agents];
    if (filter === 'running') list = list.filter((a) => a.state === 'running');
    if (filter === 'exited') list = list.filter((a) => a.state === 'exited');
    return list;
  }, [agents, filter]);

  // Derive the selected agent from the live list rather than holding a snapshot.
  // A snapshot goes stale on every 15s poll (status, ports, imageOutdated) and
  // survives deletion; deriving means a rename shows up on the next load() and a
  // deleted agent can't leave a detail panel pointing at something that's gone.
  const selected = useMemo(
    () => (selectedId ? agents.find((a) => a.agentId === selectedId) ?? null : null),
    [agents, selectedId],
  );

  // The selection can vanish under us — deleted here, or from another tab/CLI
  // and picked up by the poll. Drop it so mobile falls back to the list instead
  // of rendering a dead detail view.
  useEffect(() => {
    if (selectedId && !agents.some((a) => a.agentId === selectedId)) {
      setSelectedId(null);
      setShowList(true);
    }
  }, [agents, selectedId]);

  /** An agent was deleted: drop it optimistically, then reconcile with the server. */
  const handleAgentDeleted = useCallback((agentId: string) => {
    // The DELETE already succeeded server-side, so removing it here is safe and
    // spares the user the round trip — the API tears down container, volume and
    // backups before it answers, which takes seconds.
    setAgents((prev) => prev.filter((a) => a.agentId !== agentId));
    void load();
  }, [load]);

  function selectAgent(agent: Agent) {
    setSelectedId(agent.agentId);
    if (isMobile) setShowList(false);
  }

  function backToList() {
    setShowList(true);
  }

  const tokenSection = (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', flexShrink: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: '0.06em', color: 'var(--violet)', marginBottom: 6, textTransform: 'uppercase' }}>
        Gateway Token
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, lineHeight: 1.4 }}>
        Shared token injected into all agent containers as OPENCLAW_GATEWAY_TOKEN. Agents use it to protect their OpenClaw Gateway.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <PasswordInput
          value={gatewayToken}
          onChange={setGatewayToken}
          placeholder="Gateway Token"
          disabled={tokenSaving || tokenLoading}
          showGenerate
          style={{ flex: '1 1 280px', minWidth: 180 }}
        />
        <Button variant="primary" size="sm" loading={tokenSaving} disabled={tokenLoading || !gatewayToken.trim()} onClick={saveToken}>
          {tokenSaving ? 'Saving...' : 'Save & Sync'}
        </Button>
      </div>
      {tokenStatus && (
        <div style={{ marginTop: 8, fontSize: 11, color: tokenStatus.type === 'success' ? 'var(--green)' : 'var(--red)' }}>
          {tokenStatus.message}
        </div>
      )}
    </div>
  );

  // Hold the skeleton until the provider check has answered too. Both effects
  // fire on mount, so this costs nothing when the check is warm (~3ms) and only
  // shows up on a cold one (~230ms) — where it's exactly what we want, since
  // that's the window the banner used to flash in.
  if (loading || providersConfigured === null) {
    return (
      <div style={{ padding: 14, display: 'grid', gap: 14 }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', background: 'var(--bg2)', padding: 12 }}>
            <SkeletonLines count={4} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{ color: '#ef4444', fontSize: 14, marginBottom: 10 }}>{error}</div>
        <Button variant="secondary" size="sm" onClick={() => load()}>
          RETRY
        </Button>
      </div>
    );
  }

  // ─── Mobile: show list or detail ───
  if (isMobile) {
    if (!showList && selected) {
      return (
        <div style={{ height: '100dvh', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', display: 'flex', flexDirection: 'column', }}>
          {/* Mobile header back - fixed top */}
          <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onClick={backToList}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M9 2L4 7l5 5"/></svg>
              BACK
            </Button>
            <span style={{ fontSize: 12, color: 'var(--violet)' }}>{selected.name}</span>
          </div>
          <ImageDownloadBanner onImageReady={handleImageReady} />
        {providersConfigured === false && <NoProviderBanner />}
          {/* Scrollable content */}
          <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <DetailPanel key={selected.agentId} agent={selected} onDeleted={handleAgentDeleted} onChanged={load} onModelSaved={refreshModelSummary} />
          </div>
        </div>
      );
    }

    // Mobile: list
    return (
      <div style={{ flex: 1, background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', display: 'flex', flexDirection: 'column', }}>
        <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--font-serif-stack)', fontSize: '20px', letterSpacing: '4px', color: 'var(--violet)' }}>AGENTS</span>
          <span style={{ fontSize: 11, color: '#888' }}>{agents.length}</span>
          <Button variant="primary" size="sm" disabled={!imageReady} onClick={() => router.push('/agents/create')} title={!imageReady ? 'Agent base image not built yet' : undefined}>
            + NEW
          </Button>
        </div>
        <div style={{ padding: '8px 14px', display: 'flex', gap: 6, borderBottom: '1px solid var(--border)' }}>
          {(['all', 'running', 'exited'] as const).map((f) => (
            <Button key={f} variant={filter === f ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>
              {f}
            </Button>
          ))} 
        </div>
        <ImageDownloadBanner onImageReady={handleImageReady} />
        {providersConfigured === false && <NoProviderBanner />}
        {tokenSection}
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {filtered.length === 0 && <div style={{ padding: 14, color: '#888', fontSize: 12 }}>No agents found</div>}
          {filtered.map((agent) => (
            <AgentListItem
              key={agent.id}
              agent={agent}
              loading={lifecycleLoading === agent.agentId}
              channelSummary={chSummary}
              modelSummary={mdSummary}
              onClick={() => selectAgent(agent)}
              onLifecycle={() => handleLifecycle(agent)}
            />
          ))}
        </div>
      </div>
    );
  }

  // ─── Desktop: split view ───
  return (
    <div style={{ flex: 1, background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'var(--font-serif-stack)', fontSize: '20px', letterSpacing: '4px', color: 'var(--violet)' }}>AGENTS</span>
          <span style={{ fontSize: 11, color: '#888' }}>{agents.length} agents · {agents.filter((a) => a.state === 'running').length} running</span>
          <Button variant="primary" size="sm" disabled={!imageReady || !providersConfigured} onClick={() => router.push('/agents/create')} title={!imageReady ? 'Agent base image not built yet' : !providersConfigured ? 'No providers configured' : undefined}>
            + NEW
          </Button>
        </div>
      </div>
      <div style={{ padding: '8px 14px', display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {(['all', 'running', 'exited'] as const).map((f) => (
          <Button key={f} variant={filter === f ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>
            {f}
          </Button>
        ))}
      </div>
      <ImageDownloadBanner onImageReady={handleImageReady} />
      {providersConfigured === false && <NoProviderBanner />}
      {tokenSection}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: '38%', minWidth: 300, borderRight: '1px solid var(--border)', overflow: 'auto' }}>
          {filtered.length === 0 && <div style={{ padding: 14, color: '#888', fontSize: 12 }}>No agents found</div>}
          {filtered.map((agent) => {
            // Match on agentId, not the container id: recreate gives the agent a
            // new container (new id) and would otherwise silently deselect it.
            const isSelected = selectedId === agent.agentId;

            return (
              <AgentListItem
                key={agent.id}
                agent={agent}
                loading={lifecycleLoading === agent.agentId}
                channelSummary={chSummary}
                modelSummary={mdSummary}
                selected={isSelected}
                onClick={() => setSelectedId(agent.agentId)}
                onLifecycle={() => handleLifecycle(agent)}
              />
            );
          })}
        </div>
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg2)', padding: 16 }}>
          {!selected ? (
            <div style={{ color: '#666', fontSize: 12, padding: 20 }}>Select an agent for details</div>
          ) : (
            // key: without it React reuses one DetailPanel instance across
            // selections, so in-flight state (deleting, recreating, restarting,
            // toasts, open confirms) leaks onto the next agent you click.
            <DetailPanel key={selected.agentId} agent={selected} onDeleted={handleAgentDeleted} onChanged={load} onModelSaved={refreshModelSummary} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Edit Agent modal ───
function EditAgentModal({ agent, onClose, onSaved }: {
  agent: Agent;
  onClose: () => void;
  /** Rename succeeded — the parent refetches so the new name propagates. */
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(agent.displayName || agent.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      setError('Display name must not be empty');
      return;
    }
    if (trimmed === (agent.displayName || agent.name)) {
      onClose();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.agentId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update');
      // Refetch the list so the new display name propagates — no full reload.
      onSaved();
      onClose();
    } catch (e: unknown) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <>
      <div
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }}
        onClick={saving ? undefined : onClose}
      >
        <div
          style={{
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 0,
            maxWidth: 400, width: '100%', maxHeight: '90vh', overflow: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 500, color: 'var(--violet)', letterSpacing: '0.05em' }}>
            <span>EDIT AGENT</span>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>✕</Button>
          </div>
          <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Input
                label="Display Name"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setError(''); }}
                placeholder="My Agent 🚀"
                error={error}
                disabled={saving}
              />
              <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>
                Container: {agent.name} · This will recreate the container. Sessions and workspace are preserved.
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save & Recreate'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Config modal ───
function ConfigModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/agents/config-json?name=${agent.name}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
        setRaw(JSON.stringify(data.config, null, 2));
      } catch (e: unknown) {
        setErr((e as Error).message || 'Failed to load config');
      } finally {
        setLoading(false);
      }
    })();
  }, [agent.name]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.65)', padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 800, width: '100%', maxHeight: '85vh',
          background: '#111', border: '1px solid var(--border)',
          borderRadius: 0, display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 14px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--violet)' }}>openclaw.json - {agent.displayName || agent.agentId || agent.name}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
          {loading && (
            <div style={{ textAlign: 'center', color: '#888', fontSize: 12, padding: 20 }}>Loading config...</div>
          )}
          {err && (
            <div style={{ color: '#ef4444', fontSize: 12 }}>{err}</div>
          )}
          {raw && (
            <pre style={{
              margin: 0, fontSize: 11, lineHeight: 1.5, color: '#ccc',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              fontFamily: 'var(--font-mono-stack)',
            }}>{raw}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Detail panel (shared between mobile & desktop) ───
function DetailPanel({ agent, onDeleted, onChanged, onModelSaved }: {
  agent: Agent;
  /** The agent is gone — the parent drops it from the list. */
  onDeleted: (agentId: string) => void;
  /** The agent changed in place (renamed, recreated) — refetch the list. */
  onChanged: () => void;
  /**
   * The model changed. Narrower than `onChanged` on purpose: only the card chip
   * needs refreshing, so this avoids refetching the whole list plus the channel
   * summary for a field the parent already knows how to reload on its own.
   */
  onModelSaved: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  // Safe to resolve during render: this panel only mounts once the agent list has
  // been fetched client-side, so it never runs in a server render. The helper
  // guards for a missing `window` regardless.
  const controlUrl = agentControlUrl(agent);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.agentId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setDeleteError(data.error || 'Delete failed');
        setDeleting(false);
        return;
      }
      setShowDeleteConfirm(false);
      // No setDeleting(false): the parent drops the agent and this panel
      // unmounts. Clearing state on an unmounted component would warn.
      onDeleted(agent.agentId);
    } catch (e: unknown) {
      setDeleteError((e as Error).message || 'Network error');
      setDeleting(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 600, margin: '16px auto', paddingBottom: 24 }}>
      {/* Status */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, background: STATUS_BULLET[agent.state] || '#888' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 500 }}>{agent.displayName || agent.name}</span>
              <Button variant="primary" size="sm" onClick={() => setShowEdit(true)} title="Edit agent settings">
                ✎
              </Button>
            </div>
            <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{agent.name}</div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{agent.status}</div>
          </div>
          {agent.template && (
            <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(146,91,252,0.12)', color: 'var(--violet)', padding: '3px 8px', borderRadius: 0, border: '1px solid rgba(146,91,252,0.25)' }}>
              template: {agent.template}
            </span>
          )}
        </div>
      </div>

      {/* Properties */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<InfoIcon size={12} />} label="PROPERTIES" />
        {([
          ['Display Name', agent.displayName || agent.name],
          ['Agent ID', agent.agentId],
          ['Container', agent.name],
          ['Image', agent.image],
          ['Tag', agent.imageTag],
          ['Template', agent.template || '-'],
          ['State', agent.state],
          ['Ports', agent.ports || '-'],
          ['Internal IP', agent.ip || '-'],
          ['Created', fmtCreated(agent.created)],
        ] as const).map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
            <span style={{ color: '#888' }}>{label}</span>
            <span style={{ color: 'var(--text)', textAlign: 'right', maxWidth: '60%', wordBreak: 'break-word' }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Channels - Telegram */}
      <ChannelSection agentId={agent.agentId} agentName={agent.name} />

      {/* Model - primary + fallbacks (moved here from the Gateway page) */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<BracesIcon size={12} />} label="MODEL" />
        <ModelSection agentId={agent.agentId} onSaved={onModelSaved} />
      </div>

      {/* Config - View openclaw.json */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<BracesIcon size={12} />} label="CONFIG" />
        <div style={{ padding: '12px 14px' }}>
          <Button variant="secondary" size="sm" onClick={() => setShowConfig(true)}>
            View openclaw.json
          </Button>
          <div style={{ fontSize: 10, color: '#666', marginTop: 6 }}>
            Inspect the full container config - providers, models, auth mode.
          </div>
        </div>
      </div>

      {/* Integrations - credentials synced to this agent */}
      <IntegrationSection agentName={agent.name} />

      {/* Restart */}
      <RestartSection agentName={agent.name} />

      {/* Backup - persistent volume backup & restore */}
      <BackupSection agentName={agent.name} />

      {/* Access - agent Control UI URL (token inline in link) */}
      {controlUrl && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
          <SectionHeader icon={<KeyIcon size={12} />} label="ACCESS" />
          <div style={{ padding: '7px 14px', fontSize: 12 }}>
            <div style={{ color: '#888', marginBottom: 2 }}>Control UI</div>
            <a href={controlUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: '#60a5fa', textDecoration: 'underline', fontSize: 12, wordBreak: 'break-all' }}
            >{controlUrl}</a>

          </div>
        </div>
      )}

      {/* Config modal */}
      {showConfig && <ConfigModal agent={agent} onClose={() => setShowConfig(false)} />}

      {/* Edit agent modal */}
      {showEdit && <EditAgentModal agent={agent} onClose={() => setShowEdit(false)} onSaved={onChanged} />}

      {/* Delete confirmation */}
      <ConfirmModal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => { setShowDeleteConfirm(false); handleDelete(); }}
        title={`Delete ${agent.name}?`}
        message="This permanently deletes the container, its persistent volume, and ALL its backups. This cannot be undone."
        confirmLabel="Delete Agent"
        cancelLabel="Cancel"
        tone="danger"
      />

      {/* Recreate */}
      {agent.imageOutdated && (
        <div style={{ marginBottom: 12, border: '1px solid rgba(234,179,8,0.3)', borderRadius: 0, padding: '10px 14px', background: 'rgba(234,179,8,0.06)' }}>
          <div style={{ fontSize: 11, color: 'var(--yellow)', marginBottom: 4, fontWeight: 500 }}>⚠ Container Outdated</div>
          <div style={{ fontSize: 11, color: '#888' }}>
            This container is running an older image. Recreate it to pick up the latest version.
          </div>
        </div>
      )}
      <RecreateSection agentName={agent.name} onRecreated={onChanged} />

      {/* Delete */}
      <div style={{ border: '1px solid rgba(239,68,68,0.3)', borderRadius: 0, background: 'rgba(239,68,68,0.04)', overflow: 'hidden' }}>
        <SectionHeader icon={<TrashIcon size={12} />} label="DANGER ZONE" danger />
        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
            Permanently delete this agent: container, persistent volume, and all backups. This cannot be undone.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="danger" size="sm" loading={deleting} onClick={() => setShowDeleteConfirm(true)}>
              {deleting ? 'Deleting...' : 'Delete Agent'}
            </Button>
          </div>
          {deleteError && (
            <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{deleteError}</div>
          )}
        </div>
      </div>

      {/* Env */}
      {agent.env.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
          <SectionHeader icon={<TerminalIcon size={12} />} label="ENV (AGENT_ / MODEL_)" />
          {agent.env.map((e) => (
            <div key={e} style={{ padding: '6px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, color: '#aaa', fontFamily: 'var(--font-mono-stack)' }}>
              {e.split('=').map((v, i) => i === 1 && v.length > 0 ? `${v.slice(0, 20)}${v.length > 20 ? '...' : ''}` : v).join('=')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Integration section - credentials synced to this agent ─── */

function IntegrationSection({ agentName }: { agentName: string }) {
  const [profiles, setProfiles] = useState<{ providerId: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setProfiles([]);
    const load = async () => {
      try {
        const res = await fetch(`/api/credentials/detect?agent=${agentName}`);
        const data: {
          agents?: { matchedProfiles: { providerId: string; label: string }[] }[];
          error?: string;
        } = await res.json();
        const matched = data.agents?.[0]?.matchedProfiles ?? [];
        setProfiles(matched);
      } catch { /* ignore */ }
      setLoading(false);
    };
    void load();
  }, [agentName]);

  const count = profiles.length;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      <SectionHeader icon={<LinkIcon size={12} />} label="INTEGRATIONS" />
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <div style={{ fontSize: 11, color: '#888' }}>Loading...</div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--text)' }}>
              {count > 0
                ? `${count} credential${count !== 1 ? 's' : ''} configured`
                : 'No credentials synced to this agent.'}
            </div>
            {count > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {profiles.map((p) => (
                  <span key={p.providerId} style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--violet)', background: 'rgba(146,91,252,0.08)', border: '1px solid rgba(146,91,252,0.2)', padding: '2px 8px' }}>
                    {p.label}
                  </span>
                ))}
              </div>
            )}
            <a
              href="/credentials"
              style={{ fontSize: 11, color: 'var(--violet)', textDecoration: 'none', cursor: 'pointer', marginTop: 4 }}
            >
              Manage credentials →
            </a>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Backup section - persistent volume backup & restore ─── */

function BackupSection({ agentName }: { agentName: string }) {
  const [backups, setBackups] = useState<{ name: string; size: string; date: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'backup' | 'restore'; label: string } | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const loadBackups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentName}/backup`);
      if (res.ok) {
        const data: { backups: { name: string; size: string; date: string }[] } = await res.json();
        setBackups(data.backups ?? []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [agentName]);

  useEffect(() => { void loadBackups(); }, [loadBackups]);

  const handleBackup = async () => {
    setStatus({ type: 'backup', label: 'Creating backup...' });
    setBackups([]);
    try {
      const res = await fetch(`/api/agents/${agentName}/backup`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Backup created: ' + data.file);
        await loadBackups();
      } else {
        showToast(data.error || 'Backup failed', 'error');
      }
    } catch (e: unknown) {
      showToast((e as Error).message, 'error');
    }
    setStatus(null);
  };

  const handleRestore = async (file: string) => {
    setRestoreConfirm(file);
  };

  const executeRestore = async () => {
    const file = restoreConfirm;
    if (!file) return;
    setRestoreConfirm(null);
    setStatus({ type: 'restore', label: `Restoring from ${file}... (container will restart)` });
    setBackups([]);
    try {
      const res = await fetch(`/api/agents/${agentName}/restore?file=${encodeURIComponent(file)}`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Restored from ' + file);
        await loadBackups();
      } else {
        showToast(data.error || 'Restore failed', 'error');
      }
    } catch (e: unknown) {
      showToast((e as Error).message, 'error');
    }
    setStatus(null);
  };

  const handleDeleteBackup = async (file: string) => {
    setStatus({ type: 'backup', label: `Deleting ${file}...` });
    try {
      const res = await fetch(`/api/agents/${agentName}/backup?file=${encodeURIComponent(file)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        showToast(data.error || 'Delete failed', 'error');
      }
      setBackups([]);
      await loadBackups();
    } catch (e: unknown) {
      showToast((e as Error).message, 'error');
    }
    setStatus(null);
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      <SectionHeader icon={<ArchiveIcon size={12} />} label="BACKUP" />
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {status && (
          <div style={{
            padding: '8px 12px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--violet)',
            background: 'rgba(146,91,252,0.08)',
            border: '1px solid rgba(146,91,252,0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <span style={{
              display: 'inline-block',
              width: 8, height: 8,
              borderRadius: '50%',
              background: 'var(--violet)',
              animation: 'pulse 1s infinite',
            }} />
            {status.label}
          </div>
        )}
        {!status && (
          <>
            {loading && <div style={{ fontSize: 11, color: '#888' }}>Loading...</div>}
            {!loading && backups.length === 0 && (
              <div style={{ fontSize: 11, color: '#888' }}>No backups yet.</div>
            )}
            {backups.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {backups.map((b) => (
                  <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'var(--font-mono)', padding: '4px 0' }}>
                    <span style={{ flex: 1, color: 'var(--text)', wordBreak: 'break-all' }}>{b.name}</span>
                    <span style={{ color: '#888', whiteSpace: 'nowrap' }}>{b.size}</span>
                    <span style={{ color: '#666', whiteSpace: 'nowrap' }}>{b.date}</span>
                    <button
                      type="button"
                      disabled={!!status}
                      onClick={() => handleRestore(b.name)}
                      style={{ background: 'none', border: '1px solid var(--violet)', color: 'var(--violet)', cursor: 'pointer', fontSize: 10, padding: '2px 6px', opacity: status ? 0.5 : 1 }}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      disabled={!!status}
                      onClick={() => handleDeleteBackup(b.name)}
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, padding: '2px', opacity: status ? 0.5 : 1 }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" size="sm" disabled={!!status} onClick={handleBackup}>
                Backup Now
              </Button>
            </div>
          </>
        )}
      </div>
      {toast && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 11, color: toast.type === 'success' ? '#22c55e' : '#ef4444' }}>
          {toast.msg}
        </div>
      )}
      <ConfirmModal
        open={restoreConfirm !== null}
        onClose={() => setRestoreConfirm(null)}
        onConfirm={executeRestore}
        title="Restore Backup"
        message={`Restore from ${restoreConfirm || ''}?\n\nThe agent container will be stopped, restored, and restarted.`}
        confirmLabel="Restore"
        cancelLabel="Cancel"
        tone="warning"
      />
    </div>
  );
}

/* ─── Restart section - simple container restart ─── */

function RestartSection({ agentName }: { agentName: string }) {
  const [restarting, setRestarting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      const res = await fetch(`/api/agents/${agentName}/restart`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Container restarted');
      } else {
        showToast(data.error || 'Restart failed');
      }
    } catch (e: unknown) {
      showToast((e as Error).message || 'Network error');
    }
    setRestarting(false);
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      <SectionHeader icon={<RotateIcon size={12} />} label="RESTART" />
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
          Restart the container without losing any data.
        </div>
        <Button variant="secondary" size="sm" loading={restarting} disabled={restarting} onClick={handleRestart}>
          {restarting ? 'Restarting...' : 'Restart Container'}
        </Button>
      </div>
      {toast && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 11, color: '#22c55e' }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/* ─── Recreate section - rebuild container from same image while keeping volume ─── */

function RecreateSection({ agentName, onRecreated }: {
  agentName: string;
  /** The container was rebuilt — the parent refetches (new id, fresh image). */
  onRecreated: () => void;
}) {
  const [recreating, setRecreating] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  };

  const handleRecreate = async () => {
    setShowConfirm(false);
    setRecreating(true);
    setError('');
    try {
      const res = await fetch(`/api/agents/${agentName}/recreate`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(data.backup ? `Recreated (backup: ${data.backup})` : 'Container recreated successfully');
        // Refetch instead of reloading: the toast stays readable and the panel
        // keeps its scroll position while the new container id comes in.
        onRecreated();
      } else {
        setError(data.error || 'Recreate failed');
      }
    } catch (e: unknown) {
      setError((e as Error).message || 'Network error');
    }
    setRecreating(false);
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      <SectionHeader icon={<PackageIcon size={12} />} label="RECREATE" />
      <div style={{ padding: '12px 14px' }}>
        {recreating && (
          <div style={{
            padding: '8px 12px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--violet)',
            background: 'rgba(146,91,252,0.08)',
            border: '1px solid rgba(146,91,252,0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
          }}>
            <span style={{
              display: 'inline-block',
              width: 8, height: 8,
              borderRadius: '50%',
              background: 'var(--violet)',
              animation: 'pulse 1s infinite',
            }} />
            Recreating container...
          </div>
        )}
        <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
          Takes an automatic backup, then rebuilds the container from the latest image - keeping workspace, config, credentials, and state intact. Use this to pick up image/OpenClaw updates.
        </div>
        <Button variant="secondary" size="sm" loading={recreating} disabled={recreating} onClick={() => setShowConfirm(true)}>
          {recreating ? 'Recreating...' : 'Recreate Container'}
        </Button>
        {error && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{error}</div>}
      </div>
      {toast && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 11, color: '#22c55e' }}>
          {toast}
        </div>
      )}
      <ConfirmModal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleRecreate}
        title="Recreate Container"
        message={`Recreate container "${agentName}"?\n\nAn automatic backup is taken first, then the container is rebuilt from the latest image. Workspace, credentials, and state are preserved in the persistent volume. If the backup fails, the recreate is aborted.`}
        confirmLabel="Recreate"
        cancelLabel="Cancel"
        tone="warning"
      />
    </div>
  );
}

/* ─── Channel section - Telegram ─── */

function ChannelSection({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ telegram: boolean } | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  const doFetchPreview = useCallback(() => {
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    fetch(`/api/agents/${encodeURIComponent(agentId)}/channels`, { signal: controller.signal })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setPreview({
            telegram: data.telegram?.connected === true,
          });
        }
      })
      .catch((e: any) => {
        if (e?.name !== 'AbortError') { /* ignore aborted */ }
      });
  }, [agentId]);

  useEffect(() => {
    setPreview(null);
    doFetchPreview();
    return () => { previewAbortRef.current?.abort(); };
  }, [doFetchPreview]);

  return (
    <>
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<LinkIcon size={12} />} label="CHANNELS" />
        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {preview === null ? (
              <span style={{ color: 'var(--text-dim)' }}>Loading...</span>
            ) : (
              <>
                <Badge tone={preview.telegram ? 'success' : 'neutral'}>
                  <span style={{ fontSize: 9 }}>{preview.telegram ? 'TG: Connected' : 'TG: Not Set'}</span>
                </Badge>
              </>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Manage Channels
          </Button>
        </div>
      </div>
      <ChannelManager
        agentId={agentId}
        agentName={agentName}
        open={open}
        onClose={() => { setOpen(false); doFetchPreview(); }}
      />
    </>
  );

}
