'use client';

/**
 * Agent base image banner on the Agents page.
 *
 * Shown when no supported OpenClaw version of the agent image is downloaded, when
 * the registry publishes a newer supported version, and while a download runs.
 * Downloading touches no agent: each agent keeps its OpenClaw version until it is
 * updated on its own.
 *
 * The percent and the status line are real (docker pull's own layer-completion
 * lines, via GET /api/agents/image-status — see lib/buildAgentImage.ts), not an
 * indeterminate animation; the bar falls back to indeterminate only for the phases
 * that report no layers (resolving the version, the local-build fallback). Cancel
 * (DELETE /api/agents/download-image) kills the running docker process; the banner
 * shows a neutral "Download canceled." rather than the generic failure message.
 *
 * A result reaches the banner even when this component instance was not mounted for
 * the live transition — switched to another page mid-download and came back, or
 * reloaded — as long as it happened within LATE_RESULT_WINDOW_MS: the server keeps the
 * last outcome (lib/buildAgentImage.ts, `lastDownloadResult`, the same idea as
 * `finished` in lib/cold-backup.ts) and image-status returns it regardless of whether a
 * download is running right now. Found by testing this exact scenario by hand
 * (2026-09-24): a fast download — the layers were already cached locally — finished
 * between a screen change and coming back, leaving no trace on screen.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../components/ui';

interface ImageStatus {
  exists: boolean;
  needsUpdate: boolean;
  downloading: boolean;
  downloadingVersion: string | null;
  /** Real percent from docker pull's own layer-completion lines; null while unknown. */
  downloadPercent: number | null;
  /** The latest status/progress line, shown verbatim while no percent is known yet. */
  downloadMessage: string | null;
  /** True right after a user-initiated cancel, for the one poll tick that catches it. */
  canceled: boolean;
  /** The last download's outcome, even one this component instance never watched live. */
  lastResult: {
    version: string;
    result: 'succeeded' | 'failed' | 'canceled';
    message: string;
    at: number;
  } | null;
  localVersions: string[];
  newestLocal: string | null;
  /** Newest supported version on the registry that is not downloaded yet. */
  available: string | null;
}

const POLL_MS = 2000;
/** How long a late-arriving result (this component instance missed the live transition)
 * is still worth showing. Long enough to cover switching screens and coming right back;
 * short enough that reopening the page an hour later shows nothing stale. */
const LATE_RESULT_WINDOW_MS = 30_000;

export default function ImageDownloadBanner({ onImageReady }: { onImageReady?: () => void }) {
  const [status, setStatus] = useState<ImageStatus>({
    exists: true, needsUpdate: false, downloading: false, downloadingVersion: null,
    downloadPercent: null, downloadMessage: null, canceled: false, lastResult: null,
    localVersions: [], newestLocal: null, available: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [justCompleted, setJustCompleted] = useState<string | null>(null);
  const [justCanceled, setJustCanceled] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const wasDownloadingRef = useRef<string | null>(null);
  const completedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canceledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The `at` of the newest `lastResult` this component instance has already shown or
   * dismissed as stale, so a late-arriving result (this instance was not mounted for the
   * live transition — a reload, a return from another page) is shown exactly once. */
  const shownResultAtRef = useRef(0);

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
          wasDownloadingRef.current = data.downloadingVersion ?? wasDownloadingRef.current ?? 'image';
          // Whatever is running now will produce the next lastResult; the one already on
          // record (from before this run) is not news any more.
          if (data.lastResult) shownResultAtRef.current = data.lastResult.at;
        } else if (wasDownloadingRef.current) {
          // Live transition: this instance watched the download start and stop.
          const finished = wasDownloadingRef.current;
          wasDownloadingRef.current = null;
          setActionLoading(false);
          setCanceling(false);
          if (data.lastResult) shownResultAtRef.current = data.lastResult.at;
          if (data.canceled) {
            setJustCanceled(true);
            if (canceledTimerRef.current) clearTimeout(canceledTimerRef.current);
            canceledTimerRef.current = setTimeout(() => setJustCanceled(false), 3000);
          } else if (data.localVersions?.includes(finished)) {
            setJustCompleted(finished);
            onImageReady?.();
            if (completedTimerRef.current) clearTimeout(completedTimerRef.current);
            completedTimerRef.current = setTimeout(() => setJustCompleted(null), 3000);
          } else {
            setError(`The OpenClaw ${finished} download did not complete. Check the Docker connection and try again.`);
          }
        } else if (
          data.lastResult &&
          data.lastResult.at > shownResultAtRef.current &&
          Date.now() - data.lastResult.at < LATE_RESULT_WINDOW_MS
        ) {
          // Arrived late: the download finished (or failed, or was canceled) while this
          // component instance was not mounted to see it — switched screens and came
          // back, or reloaded. Same feedback a live transition would have shown, sourced
          // from the server's own record instead of a transition only this tab could see.
          shownResultAtRef.current = data.lastResult.at;
          if (data.lastResult.result === 'canceled') {
            setJustCanceled(true);
            if (canceledTimerRef.current) clearTimeout(canceledTimerRef.current);
            canceledTimerRef.current = setTimeout(() => setJustCanceled(false), 3000);
          } else if (data.lastResult.result === 'succeeded') {
            setJustCompleted(data.lastResult.version);
            onImageReady?.();
            if (completedTimerRef.current) clearTimeout(completedTimerRef.current);
            completedTimerRef.current = setTimeout(() => setJustCompleted(null), 3000);
          } else {
            setError(data.lastResult.message || `The OpenClaw ${data.lastResult.version} download did not complete.`);
          }
        } else if (data.lastResult) {
          // Already shown, or too old to matter: just remember it so it cannot retrigger.
          shownResultAtRef.current = Math.max(shownResultAtRef.current, data.lastResult.at);
        }
      } catch { /* ignore */ }

      if (active) setTimeout(tick, POLL_MS);
    };

    tick();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    return () => {
      if (completedTimerRef.current) clearTimeout(completedTimerRef.current);
      if (canceledTimerRef.current) clearTimeout(canceledTimerRef.current);
    };
  }, []);

  const handleDownload = useCallback(async (version: string | null) => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agents/download-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(version ? { version } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to start download' }));
        setError(data.error || 'Failed to start download');
        setActionLoading(false);
        return;
      }
      const data = await res.json().catch(() => ({})) as { version?: string };
      wasDownloadingRef.current = data.version ?? version ?? 'image';
    } catch (e: unknown) {
      setError((e as Error).message || 'Download failed');
      setActionLoading(false);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    setCanceling(true);
    try {
      const res = await fetch('/api/agents/download-image', { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({ error: 'Failed to cancel' }));
        setError(data.error || 'Failed to cancel');
        setCanceling(false);
      }
      // On success the poll tick clears `canceling` once the download actually stops.
    } catch (e: unknown) {
      setError((e as Error).message || 'Failed to cancel');
      setCanceling(false);
    }
  }, []);

  const isDownloading = status.downloading || actionLoading;
  const showBanner = status.needsUpdate || isDownloading || justCompleted || justCanceled || error;

  if (!showBanner && status.exists && !isDownloading) return null;

  // ─── Downloading ───
  if (isDownloading) {
    const version = status.downloadingVersion ?? status.available;
    const percent = status.downloadPercent;
    return (
      <Banner downloading>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              display: 'inline-block', width: 8, height: 8,
              borderRadius: '50%',
              background: 'var(--violet)',
              animation: 'pulse 1.5s ease-in-out infinite',
              flexShrink: 0,
            }} />
            <span style={{ color: 'var(--violet)', fontWeight: 500 }}>
              {version ? `Downloading the OpenClaw ${version} agent image…` : 'Downloading the agent image…'}
              {percent !== null ? ` ${percent}%` : ''}
            </span>
          </div>
          {status.downloadMessage && (
            <span style={{ color: 'var(--text-dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {status.downloadMessage}
            </span>
          )}
        </div>
        <div style={{
          flex: 1, maxWidth: 120, height: 3,
          background: 'var(--border)', borderRadius: 2, overflow: 'hidden', flexShrink: 0,
        }}>
          {percent !== null ? (
            <div style={{ height: 3, background: 'var(--violet)', width: `${percent}%`, borderRadius: 2 }} />
          ) : (
            <div style={{
              height: 3, background: 'var(--violet)',
              animation: 'progress-indeterminate 1.5s ease-in-out infinite',
              width: '40%', borderRadius: 2,
            }} />
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={() => { void handleCancel(); }} loading={canceling} disabled={canceling}>
          {canceling ? 'Canceling…' : 'Cancel'}
        </Button>
      </Banner>
    );
  }

  // ─── Just completed ───
  if (justCompleted) {
    return (
      <Banner success>
        <div style={{ flex: 1 }}>
          <span style={{ color: '#22c55e', fontWeight: 500 }}>✓ OpenClaw {justCompleted} agent image ready</span>
        </div>
      </Banner>
    );
  }

  // ─── Just canceled ───
  if (justCanceled) {
    return (
      <Banner>
        <div style={{ flex: 1 }}>
          <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>Download canceled.</span>
        </div>
      </Banner>
    );
  }

  // ─── Needs download ───
  return (
    <Banner warning>
      <div style={{ flex: 1 }}>
        <strong style={{ color: '#fbbf24' }}>
          {status.exists
            ? `⚠ OpenClaw ${status.available} is available.`
            : '⚠ Agent base image not found.'}
        </strong>
        {' '}{status.exists
          ? 'Download it for new agents; existing agents keep their version until they are updated.'
          : 'Download it to create agent containers.'}
        {error && <div style={{ color: '#ef4444', fontSize: 11, marginTop: 4 }}>{error}</div>}
      </div>
      {(status.exists ? status.available : true) && (
        <Button variant="primary" size="sm" onClick={() => { void handleDownload(status.available); }} loading={actionLoading}>
          {actionLoading ? 'Starting…' : status.exists ? `Download ${status.available}` : 'Download Image'}
        </Button>
      )}
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
