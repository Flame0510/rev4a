'use client';

import { useEffect, useState } from 'react';

interface VersionInfo {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
}

export default function UpdateBanner() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/update-check?check=1')
      .then((r) => r.json())
      .then((d: VersionInfo) => {
        if (d.updateAvailable) setInfo(d);
      })
      .catch(() => {});
  }, []);

  async function handleUpdate() {
    setUpdating(true);
    setUpdatingStatus('Updating...');

    try {
      const res = await fetch('/api/update-check', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json();
      if (data.success) {
        setUpdatingStatus(`Updated to v${data.newVersion}. Restarting...`);
        setTimeout(() => window.location.reload(), 3000);
      } else {
        setUpdatingStatus(`Failed: ${data.error}`);
        setTimeout(() => { setUpdating(false); setUpdatingStatus(null); }, 5000);
      }
    } catch (err: any) {
      setUpdatingStatus(`Error: ${err.message}`);
      setTimeout(() => { setUpdating(false); setUpdatingStatus(null); }, 5000);
    }
  }

  if (!info || (dismissed && !updatingStatus)) return null;

  return (
    <div className="update-banner">
      <div className="update-banner__inner">
        <span className="update-banner__text">
          {updatingStatus || (
            <>
              <span className="update-banner__label">Update available</span>
              <span className="update-banner__sep">&mdash;</span>
              v{info.latest}
              <span className="update-banner__sep">(installed: v{info.installed})</span>
            </>
          )}
        </span>

        {!updating && !updatingStatus && (
          <div className="update-banner__actions">
            <button className="update-banner__btn" onClick={handleUpdate}>
              Update
            </button>
            <button className="update-banner__dismiss" onClick={() => setDismissed(true)}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
