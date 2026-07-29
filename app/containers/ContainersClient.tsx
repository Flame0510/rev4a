'use client';

import { useEffect, useState } from 'react';
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
}

export default function ContainersClient() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    try {
      const res = await fetch('/api/containers');
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      setContainers(Array.isArray(data) ? data : []);
    } catch(e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load() }, []);
  useEffect(() => { const i = setInterval(load, 15000); return () => clearInterval(i); }, []);

  return (
    <div style={{ padding: '24px', maxWidth: 960, margin: '0 auto', minHeight: '100dvh', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <h1 style={{ fontSize: 22, fontWeight: 400, color: 'var(--copper)', letterSpacing: 2, marginBottom: 4 }}>CONTAINERS</h1>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 20 }}>
        {containers.length} container · {new Date().toLocaleTimeString('it-IT')}
        <Button variant="ghost" size="sm" onClick={load}>↻</Button>
      </p>

      {loading && <p style={{ color: 'var(--text-dim)' }}>Loading...</p>}
      {error && <p style={{ color: '#ef4444', fontSize: 13 }}>{error}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {containers.map(c => (
          <div key={c.id} style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
              background: c.state === 'running' ? 'var(--green)' : (c.state === 'restarting' ? 'var(--yellow)' : 'var(--red)')
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{c.name}</span>
                {c.agentId && <Pill tone="accent">{c.agentId}</Pill>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span>{c.image}</span>
                {c.ip && <span>{c.ip}</span>}
                {c.ports && <span>{c.ports}</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {c.state === 'running' && (
                <a
                  href={`/containers/terminal/${encodeURIComponent(c.name)}`}
                  className="container-terminal-link"
                >
                  TERMINAL
                </a>
              )}
              <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{c.status}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
