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

  if (!info || dismissed) return null;

  return (
    <div className="update-banner">
      <span className="update-banner-text">
        🆕 Olympus v{info.latest} available (installed: v{info.installed})
      </span>
      <span className="update-banner-actions">
        <button
          onClick={() => {
            navigator.clipboard.writeText(
              'npm install -g @flame0510/olympus@latest',
            );
            alert('Copied! Run this command + restart olympus serve');
          }}
        >
          📋 Copy command
        </button>
        <button onClick={() => setDismissed(true)}>✕</button>
      </span>
    </div>
  );
}
