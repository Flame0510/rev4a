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
        if (d.updateAvailable) {
          setInfo(d);
        }
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
        setTimeout(() => {
          setUpdating(false);
          setUpdatingStatus(null);
        }, 5000);
      }
    } catch (err: any) {
      setUpdatingStatus(`Error: ${err.message}`);
      setTimeout(() => {
        setUpdating(false);
        setUpdatingStatus(null);
      }, 5000);
    }
  }

  if (!info || (dismissed && !updatingStatus)) return null;

  return (
    <div className="update-banner">
      <span className="update-banner-text">
        {updatingStatus || (
          <>
            Olympus <strong>v{info.latest}</strong> available (v{info.installed} installed)
          </>
        )}
      </span>
      <span className="update-banner-actions">
        {!updating && !updatingStatus && (
          <>
            <button className="update-banner-btn-primary" onClick={handleUpdate}>
              Update
            </button>
            <button className="update-banner-btn-secondary" onClick={() => setDismissed(true)}>
              Dismiss
            </button>
          </>
        )}
      </span>
    </div>
  );
}
