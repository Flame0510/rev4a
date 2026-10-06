'use client';

/**
 * Agent base image banner on the Agents page.
 *
 * Shown when no supported OpenClaw version of the agent image is downloaded, when
 * the registry publishes a newer supported version, when a downloaded version is an
 * older build than the one this Rev4a release pins (`outdatedVersions`), and while a
 * download runs. Downloading touches no agent: each agent keeps its image, and its
 * OpenClaw version, until it is recreated from its own panel (or updated to a newer version).
 *
 * The percent and the status line are real (docker pull's own per-layer lines, via
 * GET /api/agents/image-status — see lib/buildAgentImage.ts); the bar is indeterminate
 * only while no percent can be computed yet (resolving the version, listing the layers,
 * the local-build fallback). Cancel (DELETE /api/agents/download-image) appears once the
 * server reports the download running, and kills the docker process.
 *
 * Every outcome — ready, cancelled, failed — comes from the server's record of the last
 * download (`lastResult`), whether this instance watched it happen or not: a download
 * that ended while the Agents page was closed or reloading is still reported, if it
 * ended less than LATE_RESULT_WINDOW_MS ago (aged with the server's clock). Each outcome
 * is shown once per page load, even though the Agents page renders this component in
 * more than one place (mobile list, mobile detail, desktop).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../components/ui';

interface ImageStatus {
  exists: boolean;
  needsUpdate: boolean;
  downloading: boolean;
  downloadingVersion: string | null;
  /** Real percent from docker pull's per-layer lines; null while it cannot be computed yet. */
  downloadPercent: number | null;
  /** The latest line of docker's output, shown under the percent. */
  downloadMessage: string | null;
  /** Whether the last finished download ended as cancelled. */
  canceled: boolean;
  /** The server's clock when it answered, used to age `lastResult.at`. */
  serverTime?: number;
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
  /** Downloaded versions whose local image is not the revision this release pins. */
  outdatedVersions?: string[];
}

const POLL_MS = 2000;
/** How long a late-arriving result (this component instance missed the live transition)
 * is still worth showing. Long enough to cover switching screens and coming right back;
 * short enough that reopening the page an hour later shows nothing stale. */
const LATE_RESULT_WINDOW_MS = 30_000;

/**
 * The newest `lastResult.at` already shown or dismissed. Module-level rather than per
 * instance: the Agents page mounts this banner in several places and remounts it when the
 * mobile view switches, and one outcome must not be announced once per mount. A page
 * reload resets it, which is intended — that is one of the cases it exists to cover.
 */
let lastShownResultAt = 0;

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
  const [cancelError, setCancelError] = useState<string | null>(null);
  const wasDownloadingRef = useRef<string | null>(null);
  const completedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canceledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;

    const tick = async () => {
      try {
        const res = await fetch('/api/agents/image-status');
        if (!active) return;
        if (!res.ok) return;
        const data: ImageStatus = await res.json();
        setStatus(data);

        const result = data.lastResult;
        const unseen = !!result && result.at > lastShownResultAt;
        const showOutcome = (r: NonNullable<ImageStatus['lastResult']>) => {
          lastShownResultAt = r.at;
          if (r.result === 'canceled') {
            setJustCanceled(true);
            if (canceledTimerRef.current) clearTimeout(canceledTimerRef.current);
            canceledTimerRef.current = setTimeout(() => setJustCanceled(false), 3000);
          } else if (r.result === 'succeeded') {
            setJustCompleted(r.version);
            onImageReady?.();
            if (completedTimerRef.current) clearTimeout(completedTimerRef.current);
            completedTimerRef.current = setTimeout(() => setJustCompleted(null), 3000);
          } else {
            setError(r.message || `The OpenClaw ${r.version} download did not complete.`);
          }
        };

        if (data.downloading) {
          setError(null);
          wasDownloadingRef.current = data.downloadingVersion ?? wasDownloadingRef.current ?? 'image';
          // The record on file is from before this run: not news any more.
          if (result) lastShownResultAt = Math.max(lastShownResultAt, result.at);
        } else if (wasDownloadingRef.current) {
          // Live transition: this instance watched the download run and stop.
          const finished = wasDownloadingRef.current;
          wasDownloadingRef.current = null;
          setActionLoading(false);
          setCanceling(false);
          setCancelError(null);
          if (result && unseen) showOutcome(result);
          else if (!result) {
            setError(`The OpenClaw ${finished} download did not complete. Check the Docker connection and try again.`);
          }
          // result present but already seen: another instance (or a late pass) announced it.
        } else if (result && unseen && (data.serverTime ?? Date.now()) - result.at < LATE_RESULT_WINDOW_MS) {
          // Arrived late: it ended while this instance was not mounted or not yet
          // watching (a reload, a return from another page, a very fast download).
          showOutcome(result);
        } else if (result) {
          // Already shown, or too old to matter: just remember it so it cannot retrigger.
          lastShownResultAt = Math.max(lastShownResultAt, result.at);
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
    setCancelError(null);
    try {
      const res = await fetch('/api/agents/download-image', { method: 'DELETE' });
      if (res.status === 404) {
        // Nothing running any more: it ended on its own; its outcome arrives with the poll.
        setCanceling(false);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to cancel' }));
        setCancelError(data.error || 'Failed to cancel');
        setCanceling(false);
      }
      // 202: the poll clears `canceling` once the download has actually stopped.
    } catch (e: unknown) {
      setCancelError((e as Error).message || 'Failed to cancel');
      setCanceling(false);
    }
  }, []);

  const isDownloading = status.downloading || actionLoading;
  const outdated = status.exists ? (status.outdatedVersions ?? [])[0] ?? null : null;
  const showBanner = status.needsUpdate || outdated !== null || isDownloading || justCompleted || justCanceled || error;

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
          {cancelError && <span style={{ color: 'var(--red)', fontSize: 11 }}>{cancelError}</span>}
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
        {/* Offered only once the server reports the download running: before that there
            is nothing to cancel, and a DELETE would answer 404. */}
        {status.downloading ? (
          <Button variant="secondary" size="sm" onClick={() => { void handleCancel(); }} loading={canceling} disabled={canceling}>
            {canceling ? 'Canceling…' : 'Cancel'}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled>Starting…</Button>
        )}
      </Banner>
    );
  }

  // ─── Just completed ───
  if (justCompleted) {
    return (
      <Banner success>
        <div style={{ flex: 1 }}>
          <span style={{ color: 'var(--green)', fontWeight: 500 }}>✓ OpenClaw {justCompleted} agent image ready</span>
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

  // ─── Needs download, or an error to report ───
  // With an image present and nothing newer published, only an error brings us here:
  // show just the error, not an "available" line with no version to name.
  const headline = !status.exists
    ? '⚠ Agent base image not found.'
    : status.available ? `⚠ OpenClaw ${status.available} is available.`
    : outdated ? `⚠ A newer build of the agent image ${outdated} is available.` : null;
  const downloadTarget = status.available ?? outdated;
  return (
    <Banner warning>
      <div style={{ flex: 1 }}>
        {headline && (
          <>
            <strong style={{ color: 'var(--yellow)' }}>{headline}</strong>
            {' '}{!status.exists
              ? 'Download it to create agent containers.'
              : status.available
                ? 'Download it for new agents; existing agents keep their version until they are updated.'
                : 'Agents keep their current image until you recreate them.'}
          </>
        )}
        {error && <div style={{ color: 'var(--red)', fontSize: headline ? 11 : 12, marginTop: headline ? 4 : 0 }}>{headline ? '' : '⚠ '}{error}</div>}
      </div>
      {(status.exists ? downloadTarget : true) && (
        <Button variant="primary" size="sm" onClick={() => { void handleDownload(downloadTarget); }} loading={actionLoading} disabled={actionLoading}>
          {actionLoading ? 'Starting…' : status.exists ? (status.available ? `Download ${status.available}` : `Download new build of ${downloadTarget}`) : 'Download Image'}
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
