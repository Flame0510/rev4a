'use client';

/**
 * "Update available" banner for Rev4a itself.
 *
 * The update is spawned by `POST /api/update-check` and restarts the server, so this
 * component cannot be told the outcome by the response. It records what it asked for,
 * waits for the server to answer again, and on the next mount compares.
 *
 * Two rules learned the hard way (2026-09-23):
 *  - a **success** is only a version that is *readable* and different. During the update
 *    npm rewrites `package.json`, and a read that fails used to answer `0.0.0`, which read
 *    as "the version moved" — the banner then said "Updated to v0.0.0" and reloaded in the
 *    middle of the install.
 *  - the banner never reloads **blindly**: if the version has not moved by the time the
 *    wait is over, it says the update has not finished (it may still be running, or it
 *    failed) and offers a Reload, instead of pretending.
 */
import { useEffect, useState } from 'react';
import { Button } from '../components/ui';

interface VersionInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  log?: string;
}

const DISMISS_KEY = 'rev4a-update-dismissed';
/** What we asked for and from which version, so the next mount can judge the outcome. */
const PENDING_KEY = 'rev4a-update-pending';

/** How long to wait for the restart before saying the update has not finished. */
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

/** A version we can believe: present and not a placeholder. */
function usableVersion(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.length > 0 && v !== '0.0.0';
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
        // Back from an update: did a *readable* version actually replace the old one?
        if (pending && usableVersion(d.installed) && d.installed !== pending.from) {
          sessionStorage.removeItem(PENDING_KEY);
          setUpdateOk(`Updated to v${d.installed}`);
          setTimeout(() => { if (active) window.location.reload(); }, 2500);
          return;
        }
        if (pending) {
          // Keep the record: a reload asks again. Say what we know, claim nothing.
          setInfo(d);
          setDismissed(false);
          setUpdateError(
            `The update to v${pending.target} has not finished: ${usableVersion(d.installed) ? `Rev4a is still on v${d.installed}` : 'Rev4a is not answering with a version'}.`
            + ` It may still be running, or it failed — see ${d.log ?? 'update.log'} in the Rev4a data directory, then reload.`,
          );
          return;
        }
        if (d.updateAvailable && usableVersion(d.latest)) {
          setInfo(d);
          setDismissed(localStorage.getItem(DISMISS_KEY) === d.latest);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  function handleDismiss() {
    if (info?.latest) localStorage.setItem(DISMISS_KEY, info.latest);
    setDismissed(true);
  }

  async function handleUpdate() {
    if (!info || !usableVersion(info.installed)) return;
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
      // The server goes down and comes back on the new version: reload once it answers
      // with a different, readable version. If it never does, say so rather than reloading
      // into a state the operator cannot interpret.
      const deadline = Date.now() + WAIT_MS;
      const poll = async () => {
        try {
          const r = await fetch('/api/update-check', { cache: 'no-store' });
          const d = (await r.json()) as VersionInfo;
          if (usableVersion(d.installed) && d.installed !== info.installed) { window.location.reload(); return; }
        } catch { /* the server is down for the update: expected */ }
        if (Date.now() > deadline) {
          setUpdating(false);
          setUpdateOk(null);
          setUpdateError('The update has not finished after two minutes. It may still be running — reload in a moment, or check update.log.');
          return;
        }
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
          ) : (
            <>
              <span className="update-banner__label">Update available</span>
              <span className="update-banner__sep">&mdash;</span>
              <span className="update-banner__version">v{info?.latest}</span>
              <span className="update-banner__sep">(installed: v{info?.installed})</span>
            </>
          )}
        </span>

        {!updateOk && (
          <div className="update-banner__actions">
            {updateError ? (
              <Button variant="primary" size="sm" onClick={handleUpdate} disabled={updating}>
                {updating ? 'Updating…' : 'Retry'}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={handleUpdate} disabled={updating}>
                {updating ? 'Updating…' : 'Update now'}
              </Button>
            )}
            {updateError && (
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload</Button>
            )}
            <Button variant="ghost" size="sm" onClick={handleDismiss}>Dismiss</Button>
          </div>
        )}
      </div>
    </div>
  );
}
