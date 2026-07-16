'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../components/ui';

interface ImageStatus {
  exists: boolean;
  needsRebuild: boolean;
  dockerfileHash?: string;
  imageHash?: string | null;
}

const LINE_LIMIT = 30;

export default function ImageRebuildBanner() {
  const [status, setStatus] = useState<ImageStatus | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [aborted, setAborted] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch('/api/agents/image-status')
      .then((r) => r.json())
      .then((d: ImageStatus) => setStatus(d))
      .catch(() => {});
  }, []);

  const handleRebuild = useCallback(async () => {
    setModalOpen(true);
    setBuilding(true);
    setError('');
    setLogs([]);
    setDone(false);
    setAborted(false);

    try {
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const res = await fetch('/api/agents/rebuild-image', {
        method: 'POST',
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) throw new Error('Failed to start rebuild');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const data = line.replace(/^data: /, '').trim();
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            setLogs((prev) => {
              if (parsed.type === 'step' || parsed.type === 'progress' || parsed.type === 'status') {
                return [...prev, parsed.message].slice(-LINE_LIMIT);
              }
              if (parsed.type === 'complete') {
                setDone(true);
                setBuilding(false);
                return [...prev, parsed.message].slice(-LINE_LIMIT);
              }
              if (parsed.type === 'error') {
                setError(parsed.message);
                setBuilding(false);
                return prev;
              }
              return prev;
            });
          } catch { /* skip */ }
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name === 'AbortError') {
        setAborted(true);
        setError('Build aborted.');
      } else {
        setError((e as Error).message || 'Rebuild failed');
      }
      setBuilding(false);
    }

    abortRef.current = null;

    fetch('/api/agents/image-status')
      .then((r) => r.json())
      .then((d: ImageStatus) => setStatus(d))
      .catch(() => {});
  }, []);

  const handleAbort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      setAborted(true);
      setBuilding(false);
      setError('Build aborted by user.');
    }
  }, []);

  const handleClose = useCallback(() => {
    if (building) return;
    setModalOpen(false);
  }, [building]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (building && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, building]);

  // Nothing to show — image is up to date
  if (!status || !status.needsRebuild) return null;

  return (
    <>
      {/* Banner trigger */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
        padding: '10px 14px',
        background: 'rgba(251,191,36,0.08)',
        borderBottom: '1px solid rgba(251,191,36,0.2)',
        fontSize: 12,
        flexShrink: 0,
      }}>
        <div>
          <strong style={{ color: '#fbbf24' }}>
            {status.exists ? '⚠ Agent base image is outdated.' : '⚠ Agent base image not found.'}
          </strong>
          {' '}{status.exists ? 'The Dockerfile has changed since the last build.' : 'Build it to create agent containers.'}
        </div>
        <Button variant="primary" size="sm" onClick={handleRebuild}>
          {status.exists ? 'Rebuild Image' : 'Build Image'}
        </Button>
      </div>

      {/* Modal */}
      {modalOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.7)',
            padding: 16,
          }}
          onClick={building ? undefined : handleClose}
        >
          <div
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              maxWidth: 560, width: '100%',
              maxHeight: '80vh',
              display: 'flex', flexDirection: 'column',
              fontFamily: 'var(--font-mono-stack)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 12, color: 'var(--copper)', letterSpacing: '0.06em' }}>
                {done ? 'BUILD COMPLETE' : aborted ? 'BUILD ABORTED' : building ? 'BUILDING...' : 'REBUILD IMAGE'}
              </span>
              {!building && (
                <button
                  onClick={handleClose}
                  style={{
                    background: 'none', border: 'none', color: '#888',
                    cursor: 'pointer', fontSize: 16, padding: '0 4px',
                  }}
                >
                  ×
                </button>
              )}
            </div>

            {/* Warning */}
            {building && (
              <div style={{
                padding: '10px 14px',
                fontSize: 11, color: '#fbbf24',
                background: 'rgba(251,191,36,0.06)',
                borderBottom: '1px solid rgba(251,191,36,0.12)',
              }}>
                <strong>Do not close or refresh this page</strong> while the build is running.
                This will stop the build process.
              </div>
            )}

            {/* Log area */}
            <div style={{
              flex: 1, overflowY: 'auto',
              padding: '8px 12px',
              fontSize: 9,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-dim)',
              background: 'rgba(0,0,0,0.2)',
              minHeight: 120,
              maxHeight: 300,
            }}>
              {logs.length === 0 && building && (
                <div style={{ color: '#888' }}>Starting build...</div>
              )}
              {logs.map((l, i) => (
                <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l}</div>
              ))}
              <div ref={logEndRef} />
              {error && <div style={{ color: '#ef4444', marginTop: 4 }}>{error}</div>}
            </div>

            {/* Progress bar (fixed, below logs) */}
            {building && (
              <div style={{ height: 3, background: 'var(--border)', overflow: 'hidden', flexShrink: 0 }}>
                <div style={{
                  height: 3, background: 'var(--copper)',
                  animation: 'progress-indeterminate 1.5s ease-in-out infinite',
                  width: '30%',
                }} />
              </div>
            )}

            {/* Footer */}
            <div style={{
              padding: '10px 14px',
              borderTop: '1px solid var(--border)',
              display: 'flex', justifyContent: 'flex-end', gap: 8,
            }}>
              {building && (
                <Button variant="ghost" size="sm" onClick={handleAbort}>
                  Abort Build
                </Button>
              )}
              {!building && (
                <Button variant="secondary" size="sm" onClick={handleClose}>
                  {done ? 'Close' : 'Cancel'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
