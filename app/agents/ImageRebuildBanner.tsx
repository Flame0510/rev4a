'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../components/ui';

interface ImageStatus {
  exists: boolean;
  needsRebuild: boolean;
  building: boolean;
  buildLog: boolean;
  dockerfileHash?: string;
  imageHash?: string | null;
}

const POLL_MS = 2000;

export default function ImageRebuildBanner() {
  const [status, setStatus] = useState<ImageStatus | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [optimisticBuilding, setOptimisticBuilding] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logIndexRef = useRef(0); // how many lines we've already seen

  const refreshStatus = useCallback(() => {
    fetch('/api/agents/image-status')
      .then((r) => r.json())
      .then((d: ImageStatus) => setStatus(d))
      .catch(() => {});
  }, []);

  const fetchLogs = useCallback(async (resetIndex = false) => {
    try {
      const after = resetIndex ? 0 : logIndexRef.current;
      const res = await fetch(`/api/agents/build-logs?after=${after}`);
      const data = await res.json();
      if (data.lines && data.lines.length > 0) {
        setLogs((prev) => {
          const next = resetIndex ? data.lines : [...prev, ...data.lines];
          return next.slice(-200);
        });
        logIndexRef.current = data.count;
        // Auto-scroll
        setTimeout(() => {
          if (logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: 'smooth' });
          }
        }, 50);
      }
    } catch { /* ignore */ }
  }, []);

  const startPolling = useCallback(() => {
    // Reset state for fresh start
    logIndexRef.current = 0;
    setLogs([]);

    // Immediate fetch
    fetchLogs(true);
    refreshStatus();

    // Start polling
    pollRef.current = setInterval(() => {
      fetchLogs(false);
      refreshStatus();
    }, POLL_MS);
  }, [fetchLogs, refreshStatus]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // Initial status check
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // When status confirms build is running, clear optimistic flag
  useEffect(() => {
    if (status && status.building && optimisticBuilding) {
      setOptimisticBuilding(false);
    }
  }, [status?.building, optimisticBuilding]);

  // When status changes, check if build just finished
  useEffect(() => {
    if (status && !status.building && !optimisticBuilding && modalOpen && pollRef.current) {
      // Build stopped — stop polling but keep modal open to show result
      stopPolling();
      // Fetch final logs
      fetchLogs(false);
      refreshStatus();
    }
  }, [status?.building, optimisticBuilding, modalOpen, stopPolling, fetchLogs, refreshStatus]);

  const handleRebuild = useCallback(async () => {
    setModalOpen(true);
    setError('');
    setOptimisticBuilding(true);

    try {
      const res = await fetch('/api/agents/rebuild-image', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to start rebuild' }));
        setError(data.error || 'Failed to start rebuild');
        setOptimisticBuilding(false);
        return;
      }

      // Build started — begin polling, first refreshStatus will confirm building=true
      startPolling();
    } catch (e: unknown) {
      setError((e as Error).message || 'Rebuild failed');
      setOptimisticBuilding(false);
    }
  }, [startPolling]);

  const handleOpenModal = useCallback(() => {
    setModalOpen(true);
    setError('');

    // If build already running, resume polling from current state
    if (status?.building) {
      // Don't reset log index — pick up where we left off
      startPolling();
    }
    // If build not running, just show the current state (or trigger rebuild)
  }, [status?.building, startPolling]);

  const handleClose = useCallback(() => {
    stopPolling();
    setOptimisticBuilding(false);
    setModalOpen(false);
    refreshStatus();
  }, [stopPolling, refreshStatus]);

  const handleAbort = useCallback(async () => {
    setOptimisticBuilding(false);
    fetch('/api/agents/abort-build', { method: 'POST' }).catch(() => {});
    stopPolling();
    setModalOpen(false);
    refreshStatus();
  }, [stopPolling, refreshStatus]);

  // Auto-scroll when logs change
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // ─── No status yet → nothing ───
  if (!status) return null;

  const isBuildActive = status.building || optimisticBuilding;
  const isBuildDone = !status.building && modalOpen && !status.needsRebuild && status.exists;

  // ─── Banner: build in background (modal closed, but build running) ───
  if (isBuildActive && !modalOpen) {
    return (
      <BannerBox>
        <div>
          <span style={{
            display: 'inline-block', width: 8, height: 8,
            borderRadius: '50%',
            background: 'var(--copper)',
            animation: 'pulse 1.5s ease-in-out infinite',
            marginRight: 8,
          }} />
          <span style={{ color: 'var(--copper)' }}>Agent base image build in progress...</span>
        </div>
        <Button variant="secondary" size="sm" onClick={handleOpenModal}>
          View Progress
        </Button>
      </BannerBox>
    );
  }

  // ─── Banner: image needs rebuild (mismatch) ───
  if (status.needsRebuild && !modalOpen) {
    return (
      <BannerBox warning>
        <div>
          <strong style={{ color: '#fbbf24' }}>
            {status.exists ? '⚠ Agent base image is outdated.' : '⚠ Agent base image not found.'}
          </strong>
          {' '}{status.exists ? 'The Dockerfile has changed since the last build.' : 'Build it to create agent containers.'}
        </div>
        <Button variant="primary" size="sm" onClick={handleRebuild}>
          {status.exists ? 'Rebuild Image' : 'Build Image'}
        </Button>
      </BannerBox>
    );
  }

  // ─── Modal ───
  if (!modalOpen) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)',
        padding: 16,
      }}
      onClick={isBuildActive ? undefined : handleClose}
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
            {isBuildDone ? 'BUILD COMPLETE' : isBuildActive ? 'BUILDING...' : error ? 'BUILD ERROR' : 'REBUILD IMAGE'}
          </span>
          {!isBuildActive && (
            <button
              onClick={handleClose}
              style={{
                background: 'none', border: 'none', color: '#888',
                cursor: 'pointer', fontSize: 16, padding: '0 4px',
              }}
            >×</button>
          )}
        </div>

        {/* Warning */}
        {isBuildActive && (
          <div style={{
            padding: '10px 14px',
            fontSize: 11, color: '#fbbf24',
            background: 'rgba(251,191,36,0.06)',
            borderBottom: '1px solid rgba(251,191,36,0.12)',
          }}>
            You can close this modal and come back later — the build continues on the server.
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
          {logs.length === 0 && isBuildActive && (
            <div style={{ color: '#888' }}>Starting build...</div>
          )}
          {logs.length === 0 && !isBuildActive && !error && (
            <div style={{ color: '#888' }}>No build in progress.</div>
          )}
          {logs.map((l, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l}</div>
          ))}
          <div ref={logEndRef} />
          {error && <div style={{ color: '#ef4444', marginTop: 4 }}>{error}</div>}
        </div>

        {/* Progress bar (fixed, below logs) */}
        {isBuildActive && (
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
          {isBuildActive && (
            <>
              <Button variant="secondary" size="sm" onClick={handleClose}>
                Run in Background
              </Button>
              <Button variant="danger" size="sm" onClick={handleAbort}>
                Abort
              </Button>
            </>
          )}
          {!isBuildActive && (
            <Button variant="secondary" size="sm" onClick={handleClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Shared banner layout used outside the modal.
 */
function BannerBox({ children, warning = false }: { children: React.ReactNode; warning?: boolean }) {
  const bg = warning ? 'rgba(251,191,36,0.08)' : 'rgba(212,155,53,0.08)';
  const border = warning ? 'rgba(251,191,36,0.2)' : 'rgba(212,155,53,0.2)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
      padding: '10px 14px',
      background: bg,
      borderBottom: `1px solid ${border}`,
      fontSize: 12,
      flexShrink: 0,
    }}>
      {children}
    </div>
  );
}
