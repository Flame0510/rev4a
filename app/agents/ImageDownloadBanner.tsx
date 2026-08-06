'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../components/ui';

interface ImageStatus {
  exists: boolean;
  needsUpdate: boolean;
  downloading: boolean;
}

const POLL_MS = 2000;

export default function ImageDownloadBanner({ onImageReady }: { onImageReady?: () => void }) {
  const [status, setStatus] = useState<ImageStatus>({ exists: true, needsUpdate: false, downloading: false });
  const [error, setError] = useState<string | null>(null);
  const [justCompleted, setJustCompleted] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const wasDownloadingRef = useRef(false);
  const completedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;

    const tick = async () => {
      try {
        const res = await fetch('/api/agents/image-status');
        if (!active) return;
        if (!res.ok) return;
        const data: ImageStatus = await res.json();
        setStatus(data);

        if (data.downloading) {
          setError(null);
        } else if (wasDownloadingRef.current) {
          setJustCompleted(true);
          setActionLoading(false);
          onImageReady?.();
          if (completedTimerRef.current) clearTimeout(completedTimerRef.current);
          completedTimerRef.current = setTimeout(() => setJustCompleted(false), 3000);
        }

        wasDownloadingRef.current = data.downloading;
      } catch { /* ignore */ }

      if (active) setTimeout(tick, POLL_MS);
    };

    tick();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    return () => {
      if (completedTimerRef.current) clearTimeout(completedTimerRef.current);
    };
  }, []);

  const handleDownload = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agents/download-image', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to start download' }));
        setError(data.error || 'Failed to start download');
        setActionLoading(false);
      }
    } catch (e: unknown) {
      setError((e as Error).message || 'Download failed');
      setActionLoading(false);
    }
  }, []);

  const isDownloading = status.downloading || actionLoading;
  const showBanner = status.needsUpdate || isDownloading || justCompleted || error;

  if (!showBanner && status.exists && !isDownloading) return null;

  // ─── Downloading ───
  if (isDownloading) {
    return (
      <Banner downloading>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8,
            borderRadius: '50%',
            background: 'var(--violet)',
            animation: 'pulse 1.5s ease-in-out infinite',
            flexShrink: 0,
          }} />
          <span style={{ color: 'var(--violet)', fontWeight: 500 }}>Downloading agent base image…</span>
        </div>
        <div style={{
          flex: 1, maxWidth: 120, height: 3,
          background: 'var(--border)', borderRadius: 2, overflow: 'hidden',
        }}>
          <div style={{
            height: 3, background: 'var(--violet)',
            animation: 'progress-indeterminate 1.5s ease-in-out infinite',
            width: '40%', borderRadius: 2,
          }} />
        </div>
        <Button variant="secondary" size="sm" disabled>Downloading…</Button>
      </Banner>
    );
  }

  // ─── Just completed ───
  if (justCompleted && !isDownloading) {
    return (
      <Banner success>
        <div style={{ flex: 1 }}>
          <span style={{ color: '#22c55e', fontWeight: 500 }}>✓ Agent base image ready</span>
        </div>
      </Banner>
    );
  }

  // ─── Needs download ───
  return (
    <Banner warning>
      <div style={{ flex: 1 }}>
        <strong style={{ color: '#fbbf24' }}>
          {status.exists ? '⚠ Agent base image is outdated.' : '⚠ Agent base image not found.'}
        </strong>
        {' '}{status.exists
          ? 'A newer version is available on the registry.'
          : 'Download it to create agent containers.'}
        {error && <div style={{ color: '#ef4444', fontSize: 11, marginTop: 4 }}>{error}</div>}
      </div>
      <Button variant="primary" size="sm" onClick={handleDownload} loading={actionLoading}>
        {actionLoading ? 'Starting…' : status.exists ? 'Download Update' : 'Download Image'}
      </Button>
    </Banner>
  );
}

function Banner({
  children, warning = false, downloading = false, success = false,
}: {
  children: React.ReactNode; warning?: boolean; downloading?: boolean; success?: boolean;
}) {
  const bg = success ? 'rgba(34,197,94,0.08)' :
             downloading ? 'rgba(146,91,252,0.1)' :
             warning ? 'rgba(251,191,36,0.08)' : 'rgba(146,91,252,0.08)';
  const border = success ? 'rgba(34,197,94,0.25)' :
                 downloading ? 'rgba(146,91,252,0.25)' :
                 warning ? 'rgba(251,191,36,0.2)' : 'rgba(146,91,252,0.2)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
      padding: '12px 14px', background: bg, borderBottom: `1px solid ${border}`,
      fontSize: 12, flexShrink: 0,
    }}>
      {children}
    </div>
  );
}
