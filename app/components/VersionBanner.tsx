'use client';

/**
 * "Update available" banner for Rev4a itself.
 *
 * The update is spawned by `POST /api/update-check` and restarts the server, so this
 * component cannot be told the outcome by the response. It records what it asked for and
 * follows the restart from the browser.
 *
 * Three rules learned from the 1.6.0 update (2026-09-23):
 *  - a **success** is only a version that is *readable* and different. During the update
 *    npm rewrites `package.json`, and a read that failed used to answer `0.0.0`, which read
 *    as "the version moved" — the banner said "Updated to v0.0.0" and reloaded mid-install.
 *  - while the restart is in flight the banner shows an **updating** state, never the
 *    "Update now" button again: nobody should think the update failed and start it twice.
 *    A page loaded in that window resumes the wait by itself and reloads when the new
 *    version answers.
 *  - the banner never reloads **blindly**: if the version has not moved by the deadline it
 *    says the update has not finished (it may still be running, or it failed), points at
 *    `update.log` and offers Retry and Reload.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui';
import {
  PENDING_TTL_MS, WAIT_MS, readPending, serverVersionMoved, fetchRunningVersion, usableVersion, writePending, clearPending,
} from './UpdatingScreen';

interface VersionInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  log?: string;
}

const DISMISS_KEY = 'rev4a-update-dismissed';

export default function VersionBanner() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateOk, setUpdateOk] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Follow the restart until the server answers with a different, readable version, then
   * reload. `from` is the version we started from, so a resumed wait knows what to expect.
   */
  const followRestart = useCallback((from: string) => {
    const deadline = Date.now() + WAIT_MS;
    const poll = async () => {
      // The wait rule lives in UpdatingScreen, shared with it: readable and different.
      if (await serverVersionMoved(from)) {
        clearPending();
        window.location.reload();
        return;
      }
      if (Date.now() > deadline) {
        setUpdating(false);
        setUpdateError('The update has not finished after a couple of minutes. It may still be running — see update.log, then reload.');
        return;
      }
      timerRef.current = setTimeout(poll, 3000);
    };
    timerRef.current = setTimeout(poll, 3000);
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/update-check?check=1')
      .then((r) => r.json())
      .then(async (d: VersionInfo) => {
        // Judged on the version the server *runs*, not package.json on disk: npm
        // replaces that before the restart, and the old server may still be answering.
        const pending = readPending();
        const running = pending ? await fetchRunningVersion() : null;
        if (!active) return;
        // Back from an update: did a *readable* version actually replace the old one?
        if (pending && usableVersion(running) && running !== pending.from) {
          clearPending();
          setUpdateOk(`Updated to v${running}`);
          setTimeout(() => { if (active) window.location.reload(); }, 2500);
          return;
        }
        if (pending && Date.now() - (pending.at ?? 0) < PENDING_TTL_MS) {
          // The restart is probably in flight (a page loaded inside that window, or a
          // reload before the new version answered): resume the wait, show no action.
          setInfo(d);
          setDismissed(false);
          setUpdating(true);
          followRestart(pending.from);
          return;
        }
        if (pending) {
          clearPending();
          setInfo(d);
          setDismissed(false);
          setUpdateError(
            `The update to v${pending.target} has not finished: ${usableVersion(running) ? `Rev4a is still on v${running}` : 'Rev4a is not answering with a version'}.`
            + ` See ${d.log ?? 'update.log'} in the Rev4a data directory, then reload.`,
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
  }, [followRestart]);

  // Clear a timer the component no longer owns (unmount or a full reload).
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

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
      writePending({ target: info.latest ?? '', from: info.installed, at: Date.now() });
      localStorage.removeItem(DISMISS_KEY);
      followRestart(info.installed);
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Network error');
      setUpdating(false);
    }
  }

  const show = Boolean(updateOk) || Boolean(updateError) || Boolean(updating) || Boolean(info?.updateAvailable && !dismissed);
  if (!show) return null;

  return (
    <div className="update-banner">
      <div className="update-banner__inner">
        <span className="update-banner__text">
          {updateOk ? (
            <span className="update-banner__ok">{updateOk}</span>
          ) : updateError ? (
            <span className="update-banner__err">{updateError}</span>
          ) : updating ? (
            <span className="update-banner__ok">Update started. Rev4a is restarting — this page reloads on its own when the new version answers.</span>
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
            {updating ? (
              // No action while the restart runs: the only honest one is to wait.
              <Button type="button" variant="ghost" size="sm" onClick={() => window.location.reload()}>Reload</Button>
            ) : updateError ? (
              <>
                <Button type="button" variant="primary" size="sm" onClick={handleUpdate}>Retry</Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload</Button>
                <Button type="button" variant="ghost" size="sm" onClick={handleDismiss}>Dismiss</Button>
              </>
            ) : (
              <>
                <Button type="button" variant="primary" size="sm" onClick={handleUpdate}>Update now</Button>
                <Button type="button" variant="ghost" size="sm" onClick={handleDismiss}>Dismiss</Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
