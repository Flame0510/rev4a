'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatMb, formatSharePercent } from '@/lib/utils/format';
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

/** What a running container consumes now, from GET /api/metrics/containers; absent when the daemon has not sampled it. */
interface Usage { cpu: number | null; mem: number | null; pids: number | null }

export default function ContainersClient() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  async function load(signal?: AbortSignal) {
    try {
      const [res, usageRes] = await Promise.all([
        fetch('/api/containers', { signal }),
        // The figures are a bonus: a daemon that has not sampled yet must not break the list.
        fetch('/api/metrics/containers?range=1h', { signal }).catch(() => null),
      ]);
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      if (!signal?.aborted) setContainers(Array.isArray(data) ? data : []);
      // The figures are shown only while they are current: a failed request, tables not created
      // yet, or a daemon that stopped sampling (newest sample older than three intervals) clears
      // them — a live container must not keep its last CPU as if it were now.
      const u = usageRes?.ok ? await usageRes.json().catch(() => null) : null;
      if (!signal?.aborted) {
        const current = u?.available && typeof u.age_s === 'number' && u.age_s <= u.interval_s * 3;
        const next: Record<string, Usage> = {};
        if (current) {
          for (const row of u.containers ?? []) {
            if (row.running && row.now) next[row.container] = { cpu: row.now.cpu_percent, mem: row.now.mem_mb, pids: row.now.pids };
          }
        }
        setUsage(next);
      }
    } catch(e: any) {
      if (e?.name === 'AbortError') return;
      if (!signal?.aborted) setError(e.message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  // One request at a time: a manual refresh or a new poll aborts the request before it, so a
  // slow answer can never overwrite a newer one.
  function refresh() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    load(controller.signal);
  }

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    return () => { abortRef.current?.abort(); clearInterval(i); };
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
          <Button variant="ghost" size="sm" onClick={refresh} aria-label="Refresh containers">↻</Button>
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

            {/* What it consumes now — running containers the daemon has sampled */}
            {c.state === 'running' && usage[c.name] && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono-stack)' }}>
                <span>CPU {formatSharePercent(usage[c.name].cpu)}</span>
                <span>Memory {formatMb(usage[c.name].mem)}</span>
                <span>PIDs {usage[c.name].pids ?? '—'}</span>
                <Link href={`/system?agent=${encodeURIComponent(c.name)}`} className="ui-link">Charts →</Link>
              </div>
            )}

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
