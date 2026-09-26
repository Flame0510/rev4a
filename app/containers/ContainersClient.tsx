'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Pill } from '../components/ui';

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  ip: string | null;
  agentId: string | null;
  displayName?: string | null;
}

export default function ContainersClient() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load(signal?: AbortSignal) {
    try {
      const res = await fetch('/api/containers', { signal });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      if (!signal?.aborted) setContainers(Array.isArray(data) ? data : []);
    } catch(e: any) {
      if (e?.name === 'AbortError') return;
      if (!signal?.aborted) setError(e.message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const i = setInterval(() => { if (!controller.signal.aborted) load(controller.signal); }, 15000);
    return () => { controller.abort(); clearInterval(i); };
  }, []);

  return (
    <div style={{ padding: '16px', maxWidth: 1080, margin: '0 auto', height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', boxSizing: 'border-box', paddingBottom: 72 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ fontSize: 20, fontWeight: 400, color: 'var(--violet)', letterSpacing: 2, margin: 0 }}>CONTAINERS</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {containers.length} container · <span style={{ fontFamily: 'var(--font-mono-stack)', fontSize: 11 }}>{new Date().toLocaleTimeString('it-IT')}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => load()}>↻</Button>
        </div>
      </div>

      {loading && <p style={{ color: 'var(--text-dim)', fontSize: 12, padding: '20px 0' }}>Loading...</p>}
      {error && <p style={{ color: '#ef4444', fontSize: 12 }}>{error}</p>}

      {/* Container cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {containers.map(c => (
          <div
            key={c.id}
            style={{
              padding: '12px 14px',
              border: '1px solid var(--border)',
              borderRadius: 0,
              background: 'var(--bg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {/* Top row: name + status bullet + actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: c.state === 'running' ? 'var(--green)' : (c.state === 'restarting' ? 'var(--yellow)' : 'var(--red)')
              }} />
              <span style={{ fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-mono-stack)', wordBreak: 'break-all', flex: '1 1 auto', minWidth: 0 }}>
                {c.name}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0, fontFamily: 'var(--font-mono-stack)' }}>
                {c.state === 'running' ? c.status.replace(/^Up\s+/, '') : c.status}
              </span>
              {c.state === 'running' && (
                // A client-side navigation (prefetched), not a full page reload.
                <Link
                  href={`/containers/terminal/${encodeURIComponent(c.name)}`}
                  style={{
                    fontSize: 10,
                    color: 'var(--violet)',
                    textDecoration: 'none',
                    border: '1px solid var(--violet)',
                    padding: '2px 8px',
                    borderRadius: 0,
                    flexShrink: 0,
                    fontFamily: 'var(--font-mono-stack)',
                    letterSpacing: '0.05em',
                  }}
                >
                  TERMINAL
                </Link>
              )}
            </div>

            {/* Second row: image + ports + ip + agent info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-dim)' }}>
              <span style={{ fontFamily: 'var(--font-mono-stack)', wordBreak: 'break-all' }}>{c.image}</span>
              {c.ip && <span style={{ fontFamily: 'var(--font-mono-stack)', color: '#888' }}>{c.ip}</span>}
              {c.ports && <span style={{ fontFamily: 'var(--font-mono-stack)', color: '#888' }}>{c.ports}</span>}
            </div>

            {/* Agent badge — only for Rev4a-managed agents */}
            {(c.displayName || c.agentId) && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {c.displayName ? (
                  <Pill tone="accent">{c.displayName}</Pill>
                ) : c.agentId ? (
                  <Pill tone="neutral">{c.agentId}</Pill>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
