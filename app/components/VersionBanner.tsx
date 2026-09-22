'use client';

/**
 * "Update available" banner for Rev4a itself.
 *
 * The update is spawned by `POST /api/update-check` and restarts the server, so this
 * component cannot be told the outcome by the response. It records what it asked for,
 * waits for the server to answer again, and on the next mount compares: if the
 * installed version moved it was updated, and if the same update is still offered it
 * did not complete (the log file says why).
 */
import { useEffect, useState } from 'react';

interface VersionInfo {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
  log?: string;
}

const DISMISS_KEY = 'rev4a-update-dismissed';
/** What we asked for and from which version, so the next mount can judge the outcome. */
const PENDING_KEY = 'rev4a-update-pending';

/** How long to poll for the restart before reloading anyway. */
const WAIT_MS = 120_000;

interface Pending { target: string; from: string }

function readPending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Pending;
    return parsed && typeof parsed.target === 'string' && typeof parsed.from === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export default function VersionBanner() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateOk, setUpdateOk] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/update-check?check=1')
      .then((r) => r.json())
      .then((d: VersionInfo) => {
        if (!active) return;
        const pending = readPending();
        // Back from an update: did the installed version actually move?
        if (pending && d.installed !== pending.from) {
          sessionStorage.removeItem(PENDING_KEY);
          setUpdateOk(`Updated to v${d.installed}`);
          setTimeout(() => { if (active) window.location.reload(); }, 2000);
          return;
        }
        if (pending) {
          sessionStorage.removeItem(PENDING_KEY);
          setInfo(d);
          setDismissed(false);
          setUpdateError(
            `The update to v${pending.target} did not complete: Rev4a is still on v${d.installed}.`
            + ` See ${d.log ?? 'update.log'} in the Rev4a data directory.`,
          );
          return;
        }
        if (d.updateAvailable) {
          setInfo(d);
          const saved = localStorage.getItem(DISMISS_KEY);
          setDismissed(saved === d.latest);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  function handleDismiss() {
    if (info?.latest) {
      localStorage.setItem(DISMISS_KEY, info.latest);
    }
    setDismissed(true);
  }

  async function handleUpdate() {
    if (!info) return;
    setUpdating(true);
    setUpdateError(null);
    setUpdateOk(null);
    try {
      const res = await fetch('/api/update-check', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) {
        setUpdateError(data.error || 'Update failed');
        setUpdating(false);
        return;
      }
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ target: info.latest ?? '', from: info.installed }));
      localStorage.removeItem(DISMISS_KEY);
      setUpdateOk('Update started. Rev4a is restarting…');
      // The server goes down and comes back on the new version: wait for its answer,
      // then reload. A timeout reloads too — the next mount reports the outcome.
      const deadline = Date.now() + WAIT_MS;
      const poll = async () => {
        if (Date.now() > deadline) { window.location.reload(); return; }
        try {
          const r = await fetch('/api/update-check', { cache: 'no-store' });
          const d = (await r.json()) as VersionInfo;
          if (d.installed !== info.installed) { window.location.reload(); return; }
        } catch { /* the server is down for the update: expected */ }
        setTimeout(poll, 3000);
      };
      setTimeout(poll, 3000);
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Network error');
      setUpdating(false);
    }
  }

  // The result states stand on their own (there may be no `info` when the update just
  // succeeded); the "available" state needs the version info and no dismissal.
  const show = Boolean(updateOk) || Boolean(updateError) || Boolean(info?.updateAvailable && !dismissed);
  if (!show) return null;

  return (
    <div className="update-banner">
      <div className="update-banner__inner">
        <span className="update-banner__text">
          {updateOk ? (
            <span className="update-banner__ok">{updateOk}</span>
          ) : updateError ? (
            <span className="update-banner__err">{updateError}</span>
          ) : info ? (
            <>
              <span className="update-banner__label">Update available</span>
              <span className="update-banner__sep">&mdash;</span>
              <span className="update-banner__version">v{info.latest}</span>
              <span className="update-banner__sep">(installed: v{info.installed})</span>
            </>
          ) : null}
        </span>

        {!updateOk && (
          <div className="update-banner__actions">
            {updateError ? (
              <button className="ui-btn ui-btn--primary ui-btn--sm" onClick={handleUpdate} disabled={updating}>
                {updating ? 'Updating…' : 'Retry'}
              </button>
            ) : (
              <button className="ui-btn ui-btn--primary ui-btn--sm" onClick={handleUpdate} disabled={updating}>
                {updating ? 'Updating…' : 'Update now'}
              </button>
            )}
            <button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={handleDismiss}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
