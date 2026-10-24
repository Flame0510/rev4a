'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { formatMb } from '@/lib/utils/format';
import { Button, ConfirmModal, Surface, showToast } from '../components/ui';

interface OrphanVolume { name: string; sizeBytes: number | null; createdAt: string | null; keptReason?: string }

const POLL_MS = 5 * 60_000;

/**
 * `agent-*-data` volumes no container uses, left by an agent that was deleted outside Rev4a or a
 * create that failed on an older release. Shown only when there are any; each is deleted on a click,
 * after a confirmation, and never automatically. From `GET /api/system/orphan-volumes`.
 */
export function OrphanVolumes({ timeZone }: { timeZone: string }) {
  const [volumes, setVolumes] = useState<OrphanVolume[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The volume being deleted, if any: every Delete button is disabled meanwhile.
  const [deleting, setDeleting] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await apiFetch('/api/system/orphan-volumes', { signal: controller.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return; // keep what is shown: a failed read must not hide a volume
      setVolumes(Array.isArray(body.volumes) ? body.volumes : []);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [load]);

  const remove = async (name: string) => {
    setConfirming(null);
    setDeleting(name);
    try {
      const res = await apiFetch(`/api/system/orphan-volumes/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      showToast(`Removed ${name}`, 'success');
    } catch (e: any) {
      showToast(e?.message || 'Could not remove the volume', 'error');
    } finally {
      setDeleting(null);
      load();
    }
  };

  if (volumes.length === 0) return null;

  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone });

  return (
    <Surface as="section" tone="warning">
      <div className="ui-kicker">Orphan agent volumes</div>
      <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
        Agent data that no container uses and no running recreate or update touches. It may be left by an agent removed outside Rev4a or by a failed create. Nothing is deleted
        automatically: check that you do not need the data, then delete it to free the space.
      </p>
      <div className="ui-key-values" style={{ marginTop: 12 }}>
        {volumes.map((v) => (
          <div key={v.name} className="ui-key-value" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {v.name}
              <span className="ui-muted" style={{ display: 'block', fontSize: 12 }}>
                {v.sizeBytes === null ? 'size unknown' : formatMb(v.sizeBytes / (1024 * 1024))}
                {v.createdAt ? ` · created ${date.format(new Date(v.createdAt))}` : ''}
              </span>
            </span>
            {v.keptReason ? (
              <span className="ui-muted" style={{ fontSize: 12, flexBasis: '100%' }}>{v.keptReason}</span>
            ) : (
              <Button
                variant="danger"
                size="sm"
                loading={deleting === v.name}
                disabled={deleting !== null}
                onClick={() => setConfirming(v.name)}
              >
                {deleting === v.name ? 'Deleting…' : 'Delete'}
              </Button>
            )}
          </div>
        ))}
      </div>
      <ConfirmModal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && remove(confirming)}
        title="Delete agent volume"
        message={`Delete "${confirming ?? ''}"?\n\nNo container uses it, but it may still hold an agent's files. This cannot be undone.`}
        confirmLabel="Delete"
        tone="danger"
      />
    </Surface>
  );
}
