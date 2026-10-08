'use client';

/**
 * Full-screen "Updating Rev4a" screen, mounted once for every page.
 *
 * While `rev4a update` replaces files, rebuilds `.next` and restarts, the old version keeps
 * serving a usable UI, and only the tab that clicked "Update now" knew. This screen asks
 * `GET /api/update-status` (one small local file, no network) so every tab — and an update
 * started from a terminal — covers the UI with the current phase until the new version
 * answers, then reloads. The server also refuses mutating API calls meanwhile (proxy.ts).
 *
 * Polling: every 3 s while an update runs (server state, or this tab's pending key from
 * VersionBanner), every 30 s otherwise so a tab that was idle notices an update.
 *
 * It also owns the wait rules shared with VersionBanner (below): a success is only a
 * *readable*, *different* version, and nothing reloads blindly.
 *
 * The first update into a version with this screen runs the old updater, which writes no
 * state: there the pending key alone shows the screen ("Updating…", then "Restarting…"
 * while the server is down) and the reload rule is the banner's, unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Button, LoadingSpinner } from './ui';

/* ── Wait rules shared with VersionBanner ─────────────────────────── */

/** What we asked for and from which version, so a reload can resume the wait. */
export const PENDING_KEY = 'rev4a-update-pending';
/** How long to wait for the restart before saying the update has not finished. */
export const WAIT_MS = 150_000;
/** How long a recorded request stays believable across reloads. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/** Fired on window when a tab records a pending update, so the screen covers it at once. */
export const PENDING_EVENT = 'rev4a-update-pending';
/** A pending key that long with no update state on the server is judged ended (see poll). */
const PENDING_GRACE_MS = 10_000;

export interface Pending { target: string; from: string; at: number }

export function readPending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Pending;
    if (!parsed || typeof parsed.target !== 'string' || typeof parsed.from !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePending(p: Pending): void {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* private mode */ }
  try { window.dispatchEvent(new Event(PENDING_EVENT)); } catch { /* no window */ }
}

export function clearPending(): void {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* private mode */ }
}

/** A version we can believe: present and not a placeholder. */
export function usableVersion(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.length > 0 && v !== '0.0.0';
}

/** True when `version` is readable and differs from the one the update started from. */
export function versionMoved(version: string | null | undefined, from: string): boolean {
  return usableVersion(version) && version !== from;
}

/**
 * The version the answering server *runs* (fixed when its process started), or null on
 * any failure (it may be restarting). Not package.json on disk: npm replaces that before
 * the build and the restart, while the old server still answers.
 */
export async function fetchRunningVersion(): Promise<string | null> {
  try {
    const res = await fetch('/api/update-status', { cache: 'no-store' });
    if (!res.ok) return null;
    const d = (await res.json()) as { version?: string | null };
    return usableVersion(d.version) ? d.version : null;
  } catch {
    return null; // the server is down for the restart: expected
  }
}

/** True when the server answers with a running version that differs from `from`. */
export async function serverVersionMoved(from: string): Promise<boolean> {
  return versionMoved(await fetchRunningVersion(), from);
}

/* ── The screen ───────────────────────────────────────────────────── */

type Phase = 'starting' | 'installing' | 'building' | 'restarting' | 'done' | 'failed';

interface UpdateStatus {
  running: boolean;
  phase: Phase | null;
  from: string | null;
  to: string | null;
  startedAt: number | null;
  error: string | null;
  version: string | null;
  logTail: string[];
}

const FAST_MS = 3_000;
const SLOW_MS = 30_000;
/** After this long the screen admits it is taking long and offers a reload. */
const LONG_MS = 5 * 60 * 1000;
const FAILED_SEEN_KEY = 'rev4a-update-failed-dismissed';

const PHASE_LABEL: Record<Phase, string> = {
  starting: 'Starting the update…',
  installing: 'Installing the new version…',
  building: 'Building Rev4a…',
  restarting: 'Restarting Rev4a…',
  done: 'Update finished. Reloading…',
  failed: 'The update failed.',
};

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function UpdatingScreen() {
  const pathname = usePathname();
  // Signed-out pages cannot read the status (it needs a session), and a wizard is not a
  // place to interrupt: the screen waits for the next page.
  const quiet = pathname === '/login' || pathname === '/setup';

  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [down, setDown] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [failedSeen, setFailedSeen] = useState<string | null>(null);
  const [busy, setBusy] = useState<'retry' | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fromRef = useRef<string | null>(null);
  const pollRef = useRef<() => void>(() => {});
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const idlePollsRef = useRef(0);

  const poll = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let fast = Boolean(readPending());
    try {
      const res = await fetch('/api/update-status', { cache: 'no-store', signal: controller.signal });
      if (res.status === 401) {
        // Not signed in (AuthGuard is about to redirect): nothing to show.
        setDown(false);
      } else if (!res.ok) {
        throw new Error(`status ${res.status}`);
      } else {
        const d = (await res.json()) as UpdateStatus;
        setDown(false);
        setStatus(d);
        let p = readPending();
        // A pending key with no state (or `done` with no version change) on the server two
        // polls in a row, past a short grace: the update ended as "already up to date", a
        // git pull brought the same version, or its state could not be written. Clear the key
        // so the screen does not stay up for nothing. A moved version reloads below first.
        if (p && !d.running && (d.phase === null || d.phase === 'done') && Date.now() - p.at > PENDING_GRACE_MS) {
          idlePollsRef.current += 1;
          if (idlePollsRef.current >= 2) {
            clearPending();
            p = null;
            idlePollsRef.current = 0;
          }
        } else {
          idlePollsRef.current = 0;
        }
        setPending(p);
        if (d.running) fromRef.current = d.from ?? fromRef.current ?? p?.from ?? d.version;
        // Only an update this tab watched running reloads from here. A tab that merely
        // holds the pending key (the old updater wrote no state) is left to VersionBanner,
        // whose reload rule is the same and which then confirms "Updated to vX".
        const from = fromRef.current;
        if (d.phase === 'failed') {
          clearPending();
          setPending(null);
        } else if (!d.running && from && versionMoved(d.version, from)) {
          // The new version answers: this is the moment to leave the screen.
          clearPending();
          window.location.reload();
          return;
        }
        fast = d.running || (Boolean(p) && Date.now() - p!.at < PENDING_TTL_MS);
      }
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return;
      // The server is down for the restart: expected, and the reason to keep polling fast.
      setDown(true);
      idlePollsRef.current = 0;
      fast = true;
    }
    timerRef.current = setTimeout(() => pollRef.current(), fast ? FAST_MS : SLOW_MS);
  }, []);
  pollRef.current = poll;

  useEffect(() => {
    if (quiet) return;
    try { setFailedSeen(localStorage.getItem(FAILED_SEEN_KEY)); } catch { /* private mode */ }
    setPending(readPending());
    poll();
    // Back to the tab: look now instead of waiting out a 30 s interval.
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    // This tab just started an update: cover it now, then poll at the fast interval.
    const onPending = () => { idlePollsRef.current = 0; setPending(readPending()); poll(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(PENDING_EVENT, onPending);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(PENDING_EVENT, onPending);
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [quiet, poll]);

  const failed = status?.phase === 'failed' && String(status.startedAt) !== failedSeen;
  const running = Boolean(status?.running);
  const pendingLive = Boolean(pending)
    && Date.now() - (pending?.at ?? 0) < PENDING_TTL_MS
    && !(pending && versionMoved(status?.version, pending.from));
  const visible = !quiet && (running || failed || pendingLive);

  // The clock only runs while the screen is up.
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [visible]);

  // Focus trap: the page behind is not usable, so focus stays on the screen.
  useEffect(() => {
    if (!visible) return;
    const dialog = dialogRef.current;
    dialog?.focus();
    const onFocusIn = (e: FocusEvent) => {
      if (dialog && e.target instanceof Node && !dialog.contains(e.target)) {
        const first = dialog.querySelector<HTMLElement>('button:not([disabled])');
        (first ?? dialog).focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [visible, failed]);

  async function handleRetry() {
    setBusy('retry');
    setRetryError(null);
    try {
      const res = await fetch('/api/update-check', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!data.success) {
        setRetryError(data.error || 'The update could not be started.');
        return;
      }
      const from = status?.from ?? status?.version ?? '';
      fromRef.current = from || null;
      writePending({ target: status?.to ?? '', from, at: Date.now() });
      setPending(readPending());
      setStatus(null);
      poll();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  function handleDismissFailure() {
    const key = String(status?.startedAt ?? '');
    try { localStorage.setItem(FAILED_SEEN_KEY, key); } catch { /* private mode */ }
    setFailedSeen(key);
  }

  if (!visible) return null;

  const from = status?.from ?? pending?.from ?? null;
  const to = status?.to ?? (pending?.target || null);
  const startedAt = status?.startedAt ?? pending?.at ?? now;
  const long = !failed && now - startedAt > LONG_MS;
  const phaseText = failed
    ? PHASE_LABEL.failed
    : down
      ? 'Restarting…'
      : status?.phase ? PHASE_LABEL[status.phase] : 'Updating…';
  const log = status?.logTail ?? [];

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(10,10,11,0.94)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, overflowY: 'auto',
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="updating-title"
        aria-describedby="updating-phase"
        tabIndex={-1}
        style={{
          width: '100%', maxWidth: 640,
          background: 'var(--bg2)', border: `1px solid ${failed ? 'var(--red)' : 'var(--border)'}`,
          padding: 24, display: 'flex', flexDirection: 'column', gap: 16, outline: 'none',
        }}
      >
        {!failed && <LoadingSpinner compact />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 id="updating-title" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: failed ? 'var(--red)' : 'var(--text)' }}>
            {failed ? 'Rev4a update failed' : 'Updating Rev4a'}
          </h1>
        </div>

        <div style={{ fontFamily: 'var(--font-mono-stack)', fontSize: 12, color: 'var(--text-dim)' }}>
          {from && to ? `v${from} → v${to}` : from ? `from v${from}` : 'Looking for the new version…'}
          {' · '}
          {elapsed(now - startedAt)}
        </div>

        <div id="updating-phase" role="status" aria-live="polite" style={{ fontSize: 14, color: 'var(--text)' }}>
          {phaseText}
        </div>

        {failed && status?.error && (
          <div style={{ fontSize: 12, color: 'var(--red)', wordBreak: 'break-word' }}>{status.error}</div>
        )}

        {!failed && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {long
              ? 'This is taking longer than expected. The update may still be running — see update.log in the Rev4a data directory, or the terminal it was started from.'
              : 'Rev4a is not usable until the update ends. This page reloads on its own when the new version answers.'}
          </div>
        )}

        {log.length > 0 && (
          <pre
            tabIndex={0}
            aria-label="Last lines of the update log"
            style={{
              margin: 0, padding: 12, maxHeight: 220, overflow: 'auto',
              background: 'var(--bg)', border: '1px solid var(--border)',
              fontFamily: 'var(--font-mono-stack)', fontSize: 11, lineHeight: 1.5,
              color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}
          >
            {log.join('\n')}
          </pre>
        )}

        {retryError && <div style={{ fontSize: 12, color: 'var(--red)' }}>{retryError}</div>}

        {(failed || long) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {failed && (
              <Button type="button" variant="primary" onClick={handleRetry} loading={busy === 'retry'} disabled={busy !== null}>
                {busy === 'retry' ? 'Retrying…' : 'Retry'}
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={() => window.location.reload()} disabled={busy !== null}>Reload</Button>
            {failed && <Button type="button" variant="ghost" onClick={handleDismissFailure} disabled={busy !== null}>Dismiss</Button>}
          </div>
        )}
      </div>
    </div>
  );
}
