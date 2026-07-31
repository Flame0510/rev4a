'use client';

import { useEffect, useState } from 'react';

interface VersionInfo {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
}

const DISMISS_KEY = 'olympus-update-dismissed';

export default function VersionBanner() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateOk, setUpdateOk] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/update-check?check=1')
      .then((r) => r.json())
      .then((d: VersionInfo) => {
        if (d.updateAvailable) {
          setInfo(d);
          const saved = localStorage.getItem(DISMISS_KEY);
          if (saved === d.latest) setDismissed(true);
          else setDismissed(false);
        }
      })
      .catch(() => {});
  }, []);

  function handleDismiss() {
    if (info?.latest) {
      localStorage.setItem(DISMISS_KEY, info.latest);
    }
    setDismissed(true);
  }

  async function handleUpdate() {
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
      if (data.success) {
        setUpdateOk('Update started. Restarting\u2026');
        localStorage.removeItem(DISMISS_KEY);
        setTimeout(function() { window.location.reload(); }, 5000);
      } else {
        setUpdateError(data.error || 'Update failed');
        setUpdating(false);
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Network error');
      setUpdating(false);
    }
  }

  if (!info || dismissed) return null;

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
              <span className="update-banner__version">v{info.latest}</span>
              <span className="update-banner__sep">(installed: v{info.installed})</span>
            </>
          )}
        </span>

        {!updateOk && (
          <div className="update-banner__actions">
            {updateError ? (
              <button className="ui-btn ui-btn--primary ui-btn--sm" onClick={handleUpdate} disabled={updating}>
                {updating ? 'Updating\u2026' : 'Retry'}
              </button>
            ) : (
              <button className="ui-btn ui-btn--primary ui-btn--sm" onClick={handleUpdate} disabled={updating}>
                {updating ? 'Updating\u2026' : 'Update now'}
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
