'use client';

import { useState, useEffect, useCallback } from 'react';
import { useResponsive } from '../design-system';
import { Button, Pill, LoadingSpinner } from '../components/ui';

type BadgeColor = 'green' | 'red' | 'gray' | 'violet' | 'blue';

function Badge({ children, color }: { children: React.ReactNode; color: BadgeColor }) {
  const toneMap: Record<BadgeColor, 'success' | 'danger' | 'neutral' | 'accent' | 'info'> = {
    green: 'success', red: 'danger', gray: 'neutral', violet: 'accent', blue: 'info',
  };
  return <Pill tone={toneMap[color]}>{children}</Pill>;
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '10px 20px',
      fontSize: 10,
      letterSpacing: 2,
      color: 'var(--violet)',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg2)',
      textTransform: 'uppercase',
      flexShrink: 0,
      fontFamily: 'var(--font-mono-stack)',
    }}>
      {children}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="empty-state">{message}</div>;
}

function ErrorState({ message }: { message: string }) {
  return <div className="error-state">⚠ {message}</div>;
}

function LoadingState() {
  return <LoadingSpinner label="LOADING" compact />;
}

// ─── Plugin type ──────────────────────────────────────────────────────────────

interface Plugin {
  id: string;
  name?: string;
  enabled: boolean;
  status?: string;
  version?: string;
  origin?: string;
  format?: string;
  source?: string;
  toolNames?: string[];
  channelIds?: string[];
  providerIds?: string[];
  cliBackendIds?: string[];
  hookNames?: string[];
  services?: string[];
  compat?: string[];
}

interface RowProps { label: string; value: string; mono?: boolean; small?: boolean; }
function Row({ label, value, mono, small }: RowProps) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 2 }}>{label.toUpperCase()}</div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: small ? 10 : 12,
        color: 'var(--text)',
        wordBreak: 'break-all',
        ...(mono ? { background: 'var(--bg3)', padding: '4px 8px', borderRadius: 0, border: '1px solid #222228' } : {}),
      }}>
        {value}
      </div>
    </div>
  );
}

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Plugin | null>(null);
  const [filter, setFilter] = useState('all');
  const [toggling, setToggling] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const isMobile = useResponsive('lg');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/plugins', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlugins(data.plugins || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = plugins.filter(p => {
    if (filter === 'enabled') return p.enabled;
    if (filter === 'disabled') return !p.enabled;
    return true;
  });

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  const handleToggle = async (plugin: Plugin) => {
    const action = plugin.enabled ? 'disable' : 'enable';
    setToggling(plugin.id);
    try {
      const res = await fetch('/api/plugins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, pluginId: plugin.id }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Plugin ${plugin.id} ${action}d`);
        await load();
        if (selected?.id === plugin.id) setSelected(p => p ? { ...p, enabled: !p.enabled } : p);
      } else {
        showToast(`Error: ${data.error}`);
      }
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`);
    } finally {
      setToggling(null);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--bg)',
      color: 'var(--text)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        height: 48,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
        flexShrink: 0,
        boxSizing: 'border-box',
      }}>
        <span style={{ fontFamily: 'var(--font-serif-stack)', fontSize: '20px', letterSpacing: '4px', color: 'var(--violet)' }}>PLUGINS</span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: isMobile ? 'column' : 'row', overflow: 'hidden' }}>
        {/* List */}
        <div style={{ width: isMobile ? '100%' : 340, maxHeight: isMobile ? '45%' : '100%', borderRight: isMobile ? 'none' : '1px solid #222228', borderBottom: isMobile ? '1px solid #222228' : 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Filter bar */}
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #222228', background: 'var(--bg2)', display: 'flex', gap: 6 }}>
            {(['all', 'enabled', 'disabled'] as const).map(f => (
              <Button key={f} variant={filter === f ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>
                {f.toUpperCase()}
              </Button>
            ))}
            <Button variant="ghost" size="sm" onClick={load} style={{ marginLeft: 'auto' }}>
              ⟳
            </Button>
          </div>

          {/* List body */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading && <LoadingState />}
            {!loading && error && <ErrorState message={error} />}
            {!loading && !error && filtered.length === 0 && <EmptyState message="no plugins match" />}
            {!loading && !error && filtered.map(p => (
              <div
                key={p.id}
                onClick={() => setSelected(p)}
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid #18181c',
                  cursor: 'pointer',
                  background: selected?.id === p.id ? 'var(--bg3)' : 'transparent',
                  borderLeft: selected?.id === p.id ? '2px solid #a78bfa' : '2px solid transparent',
                  transition: 'all 0.1s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--text)', flex: 1 }}>
                    {p.name || p.id}
                  </span>
                  <Badge color={p.enabled ? 'green' : 'gray'}>{p.status || (p.enabled ? 'enabled' : 'disabled')}</Badge>
                </div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: 'var(--text-dim)' }}>
                  {p.id} {p.version ? `· v${p.version}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!selected ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
              ← select a plugin
            </div>
          ) : (
            <>
              <PanelTitle>PLUGIN — {selected.id}</PanelTitle>
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                  <h2 style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: 'var(--text)', margin: 0 }}>{selected.name || selected.id}</h2>
                  <Badge color={selected.enabled ? 'green' : 'gray'}>{selected.status || (selected.enabled ? 'enabled' : 'disabled')}</Badge>
                  <Badge color={selected.origin === 'bundled' ? 'blue' : 'violet'}>{selected.origin || 'unknown'}</Badge>
                </div>

                {selected.version && <Row label="Version" value={selected.version} />}
                <Row label="ID" value={selected.id} />
                <Row label="Format" value={selected.format || '—'} />
                {selected.source && <Row label="Source" value={selected.source} mono small />}

                {([
                  ['Tools', selected.toolNames],
                  ['Channels', selected.channelIds],
                  ['Providers', selected.providerIds],
                  ['CLI Backends', selected.cliBackendIds],
                  ['Hooks', selected.hookNames],
                  ['Services', selected.services],
                ] as [string, string[] | undefined][]).map(([label, arr]) => arr && arr.length > 0 && (
                  <div key={label} style={{ marginBottom: 12 }}>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 4 }}>{label.toUpperCase()}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {arr.map(s => <Badge key={s} color="gray">{s}</Badge>)}
                    </div>
                  </div>
                ))}

                {selected.compat && selected.compat.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 4 }}>COMPAT</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {selected.compat.map(c => <Badge key={c} color="violet">{c}</Badge>)}
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 24 }}>
                  <Button
                    variant={selected.enabled ? 'danger' : 'success'}
                    size="sm"
                    onClick={() => handleToggle(selected)}
                    disabled={toggling === selected.id}
                    loading={toggling === selected.id}
                  >
                    {selected.enabled ? 'DISABLE' : 'ENABLE'}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>

        {toastMsg && (
          <div style={{
            position: 'fixed', bottom: 24, right: 24,
            background: 'var(--bg2)', border: '1px solid #a78bfa',
            color: 'var(--text)', fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12, padding: '10px 18px', borderRadius: 0,
            zIndex: 1000,
          }}>
            {toastMsg}
          </div>
        )}
      </div>
    </div>
  );
}
