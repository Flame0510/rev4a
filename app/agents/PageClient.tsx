'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { SkeletonLines } from '../components/Skeleton';
import { Button, ListItem, type Tone } from '../components/ui';
import PasswordInput from '../components/PasswordInput';

interface Agent {
  id: string;
  agentId: string;
  name: string;
  image: string;
  imageTag: string;
  template: string | null;
  status: string;
  state: string;
  ports: string;
  ip: string | null;
  created: string | null;
  env: string[];
  traefikUrl: string | null;
  authToken: string | null;
}

type FilterState = 'all' | 'running' | 'exited';

const STATUS_BULLET: Record<string, string> = {
  running: '#22c55e',
  exited: '#ef4444',
  paused: '#f59e0b',
  restarting: '#3b82f6',
};

function fmtCreated(created: string | null): string {
  if (!created) return '—';
  const ms = Date.now() - new Date(created).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function AgentsPageClient() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<FilterState>('all');
  const [selected, setSelected] = useState<Agent | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [showList, setShowList] = useState(true);
  const [token, setToken] = useState('');
  const [tokenLoading, setTokenLoading] = useState(true);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenStatus, setTokenStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
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
    } catch (e: any) {
      setError(e.message || 'Loading error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const i = setInterval(load, 15000); return () => clearInterval(i); }, [load]);

  const loadToken = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/token');
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      setToken(typeof data.token === 'string' ? data.token : '');
    } catch (e: any) {
      setTokenStatus({ type: 'error', message: e.message || 'Token loading error' });
    } finally {
      setTokenLoading(false);
    }
  }, []);

  useEffect(() => {
    loadToken();
  }, [loadToken]);

  useEffect(() => {
    if (!tokenStatus) return;
    const timeoutId = window.setTimeout(() => setTokenStatus(null), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [tokenStatus]);

  const filtered = useMemo(() => {
    let list = [...agents];
    if (filter === 'running') list = list.filter((a) => a.state === 'running');
    if (filter === 'exited') list = list.filter((a) => a.state === 'exited');
    return list;
  }, [agents, filter]);

  function selectAgent(agent: Agent) {
    setSelected(agent);
    if (isMobile) setShowList(false);
  }

  function backToList() {
    setShowList(true);
  }

  async function saveToken() {
    setTokenSaving(true);
    setTokenStatus(null);
    try {
      const res = await fetch('/api/agents/token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Save failed');
      }
      setTokenStatus({
        type: 'success',
        message: `✓ Token saved and synced to ${data.containersUpdated} containers`,
      });
      load();
    } catch (e: any) {
      setTokenStatus({ type: 'error', message: e.message || 'Save failed' });
    } finally {
      setTokenSaving(false);
    }
  }

  const tokenSection = (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <PasswordInput
          value={token}
          onChange={setToken}
          placeholder="Agents Gateway Token"
          disabled={tokenSaving || tokenLoading}
          style={{ flex: '1 1 280px', minWidth: 180 }}
        />
        <Button variant="secondary" size="sm" loading={tokenSaving} disabled={tokenLoading} onClick={saveToken}>
          {tokenSaving ? 'Saving...' : 'Save & Sync'}
        </Button>
      </div>
      {tokenStatus && (
        <div style={{ marginTop: 8, fontSize: 11, color: tokenStatus.type === 'success' ? '#22c55e' : '#ef4444' }}>
          {tokenStatus.message}
        </div>
      )}
    </div>
  );

  if (loading) {
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
        <Button variant="secondary" size="sm" onClick={load}>
          RETRY
        </Button>
      </div>
    );
  }

  // ─── Mobile: mostra lista o dettaglio ───
  if (isMobile) {
    if (!showList && selected) {
      return (
        <div style={{ height: '100vh', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', display: 'flex', flexDirection: 'column', paddingBottom: 54, boxSizing: 'border-box' }}>
          {/* Mobile header back — fixed top */}
          <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onClick={backToList}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M9 2L4 7l5 5"/></svg>
              BACK
            </Button>
            <span style={{ fontSize: 12, color: 'var(--copper)' }}>{selected.name}</span>
          </div>
          {/* Scrollable content */}
          <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <DetailPanel agent={selected} />
          </div>
        </div>
      );
    }

    // Mobile: lista
    return (
      <div style={{ height: '100vh', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', display: 'flex', flexDirection: 'column', paddingBottom: 54, boxSizing: 'border-box' }}>
        <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--font-serif-stack)', fontSize: '20px', letterSpacing: '4px', color: 'var(--copper)' }}>AGENTS</span>
          <span style={{ fontSize: 11, color: '#888' }}>{agents.length}</span>
          <Button variant="ghost" size="sm" onClick={() => router.push('/agents/create')}>
            + NEW
          </Button>
        </div>
        {tokenSection}
        <div style={{ padding: '8px 14px', display: 'flex', gap: 6, borderBottom: '1px solid var(--border)' }}>
          {(['all', 'running', 'exited'] as const).map((f) => (
            <Button key={f} variant={filter === f ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>
              {f}
            </Button>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {filtered.length === 0 && <div style={{ padding: 14, color: '#888', fontSize: 12 }}>No agents found</div>}
          {filtered.map((agent) => (
            <ListItem key={agent.id} onClick={() => selectAgent(agent)} style={{ padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: STATUS_BULLET[agent.state] || '#888' }} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>{agent.name}</span>
                {agent.template && (
                  <span style={{ fontSize: 10, background: 'rgba(212,155,53,0.12)', color: 'var(--copper)', padding: '1px 6px', borderRadius: 0, border: '1px solid rgba(212,155,53,0.25)' }}>{agent.template}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                {agent.image?.includes('/') ? agent.image.split('/').pop() : agent.image}
                {agent.ports && <span style={{ marginLeft: 8 }}>{agent.ports}</span>}
              </div>
            </ListItem>
          ))}
        </div>
      </div>
    );
  }

  // ─── Desktop: split view ───
  return (
    <div style={{ height: '100vh', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'var(--font-serif-stack)', fontSize: '20px', letterSpacing: '4px', color: 'var(--copper)' }}>AGENTS</span>
          <span style={{ fontSize: 11, color: '#888' }}>{agents.length} agents · {agents.filter((a) => a.state === 'running').length} running</span>
          <Button variant="ghost" size="sm" onClick={() => router.push('/agents/create')}>
            + NEW
          </Button>
        </div>
      </div>
      {tokenSection}
      <div style={{ padding: '8px 14px', display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {(['all', 'running', 'exited'] as const).map((f) => (
          <Button key={f} variant={filter === f ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>
            {f}
          </Button>
        ))}
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: '38%', minWidth: 300, borderRight: '1px solid var(--border)', overflow: 'auto' }}>
          {filtered.length === 0 && <div style={{ padding: 14, color: '#888', fontSize: 12 }}>No agents found</div>}
          {filtered.map((agent) => {
            const isSelected = selected?.id === agent.id;
            return (
              <ListItem key={agent.id} onClick={() => setSelected(agent)} active={isSelected} style={{ padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: STATUS_BULLET[agent.state] || '#888' }} />
                  <span style={{ color: isSelected ? 'var(--copper)' : 'var(--text)', fontSize: 13, fontWeight: 500 }}>{agent.name}</span>
                  {agent.template && (
                    <span style={{ fontSize: 10, background: 'rgba(212,155,53,0.12)', color: 'var(--copper)', padding: '1px 6px', borderRadius: 0, border: '1px solid rgba(212,155,53,0.25)' }}>{agent.template}</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#666', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <span>{agent.image?.includes('/') ? agent.image.split('/').pop() : agent.image}</span>
                  {agent.ip && <span>{agent.ip}</span>}
                  {agent.ports && <span style={{ color: '#888' }}>{agent.ports}</span>}
                </div>
              </ListItem>
            );
          })}
        </div>
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg2)', padding: 16 }}>
          {!selected ? (
            <div style={{ color: '#666', fontSize: 12, padding: 20 }}>Select an agent for details</div>
          ) : (
            <DetailPanel agent={selected} />
          )}
        </div>
      </div>
    </div>
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
          <span style={{ fontSize: 12, color: 'var(--copper)' }}>openclaw.json — {agent.name}</span>
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
function DetailPanel({ agent }: { agent: Agent }) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [showConfig, setShowConfig] = useState(false);

  const handleDelete = async () => {
    if (!confirm(`Delete agent "${agent.name}"? This will stop and remove the container.`)) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const res = await fetch(`/api/agents/${agent.name}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setDeleteError(data.error || 'Delete failed');
        setDeleting(false);
        return;
      }
      window.location.reload();
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
            <div style={{ fontSize: 16, fontWeight: 500 }}>{agent.name}</div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{agent.status}</div>
          </div>
          {agent.template && (
            <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(212,155,53,0.12)', color: 'var(--copper)', padding: '3px 8px', borderRadius: 0, border: '1px solid rgba(212,155,53,0.25)' }}>
              template: {agent.template}
            </span>
          )}
        </div>
      </div>

      {/* Properties */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', color: 'var(--copper)', fontSize: 10, letterSpacing: '0.08em' }}>PROPERTIES</div>
        {([
          ['Agent ID', agent.agentId],
          ['Container ID', agent.id],
          ['Image', agent.image],
          ['Tag', agent.imageTag],
          ['Template', agent.template || '—'],
          ['State', agent.state],
          ['Ports', agent.ports || '—'],
          ['Internal IP', agent.ip || '—'],
          ['Created', fmtCreated(agent.created)],
        ] as const).map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
            <span style={{ color: '#888' }}>{label}</span>
            <span style={{ color: 'var(--text)', textAlign: 'right', maxWidth: '60%', wordBreak: 'break-word' }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Config — View openclaw.json */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', color: 'var(--copper)', fontSize: 10, letterSpacing: '0.08em' }}>CONFIG</div>
        <div style={{ padding: '12px 14px' }}>
          <Button variant="secondary" size="sm" onClick={() => setShowConfig(true)}>
            View openclaw.json
          </Button>
          <div style={{ fontSize: 10, color: '#666', marginTop: 6 }}>
            Inspect the full container config — providers, models, auth mode.
          </div>
        </div>
      </div>

      {/* Integrations — credentials synced to this agent */}
      <IntegrationSection agentName={agent.name} />

      {/* Access — Traefik URL (token inline in link) */}
      {agent.traefikUrl && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
          <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', color: 'var(--copper)', fontSize: 10, letterSpacing: '0.08em' }}>ACCESS TOKEN</div>
          <div style={{ padding: '7px 14px', fontSize: 12 }}>
            <div style={{ color: '#888', marginBottom: 2 }}>Control UI</div>
            <a href={agent.traefikUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: '#60a5fa', textDecoration: 'underline', fontSize: 12, wordBreak: 'break-all' }}
            >{agent.traefikUrl}</a>
          </div>
        </div>
      )}

      {/* Config modal */}
      {showConfig && <ConfigModal agent={agent} onClose={() => setShowConfig(false)} />}

      {/* Delete */}
      <div style={{ border: '1px solid rgba(239,68,68,0.3)', borderRadius: 0, background: 'rgba(239,68,68,0.04)', overflow: 'hidden' }}>
        <div style={{ padding: '8px 14px', borderBottom: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: 10, letterSpacing: '0.08em' }}>DANGER ZONE</div>
        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
            Delete this agent. This will stop and remove the Docker container. This action cannot be undone.
          </div>
          <Button variant="danger" size="sm" loading={deleting} onClick={handleDelete}>
            {deleting ? 'Deleting...' : 'Delete Agent'}
          </Button>
          {deleteError && (
            <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{deleteError}</div>
          )}
        </div>
      </div>

      {/* Env */}
      {agent.env.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
          <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', color: 'var(--copper)', fontSize: 10, letterSpacing: '0.08em' }}>ENV (AGENT_ / MODEL_)</div>
          {agent.env.map((e) => (
            <div key={e} style={{ padding: '6px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, color: '#aaa', fontFamily: 'var(--font-mono-stack)' }}>
              {e.split('=').map((v, i) => i === 1 && v.length > 0 ? `${v.slice(0, 20)}${v.length > 20 ? '…' : ''}` : v).join('=')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Integration section — credentials synced to this agent ─── */

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
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', color: 'var(--copper)', fontSize: 10, letterSpacing: '0.08em' }}>INTEGRATIONS</div>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <div style={{ fontSize: 11, color: '#888' }}>Loading…</div>
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
                  <span key={p.providerId} style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--copper)', background: 'rgba(212,155,53,0.08)', border: '1px solid rgba(212,155,53,0.2)', padding: '2px 8px' }}>
                    {p.label}
                  </span>
                ))}
              </div>
            )}
            <a
              href="/credentials"
              style={{ fontSize: 11, color: 'var(--copper)', textDecoration: 'none', cursor: 'pointer', marginTop: 4 }}
            >
              Manage credentials →
            </a>
          </>
        )}
      </div>
    </div>
  );
}
