'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Surface } from '../components/ui';

const POLL_MS = 15_000;

interface MigrationState {
  status: 'pending' | 'running' | 'done' | 'stopped';
  reason: string | null;
  moved: number;
  remaining: number;
  skipped?: { name: string; reason: string }[];
}

/**
 * One line while the backups of older releases are being moved from the Docker volume
 * `rev4a-backups` into the backups folder, or when that move stopped. Renders nothing once it is
 * done (and while the answer is unknown). Polling stops when the move is done.
 */
export function BackupsMigrationNotice() {
  const [state, setState] = useState<MigrationState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      let next: MigrationState | null = null;
      try {
        const res = await apiFetch('/api/system/backups-migration', { signal: controller.signal });
        if (res.ok) next = (await res.json()) as MigrationState;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
      }
      if (stopped) return;
      setState(next);
      if (next?.status !== 'done') timer = setTimeout(load, POLL_MS);
    };
    load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, []);

  if (!state || state.status === 'done') return null;
  const text = state.status === 'stopped'
    ? `Moving old backups to the backups folder stopped: ${state.reason ?? 'unknown reason'}. ${state.reason === 'Docker did not answer' ? 'It tries again every few minutes.' : 'It resumes at the next start.'}`
    : `Moving old backups from the Docker volume to the backups folder${state.remaining > 0 ? ` (${state.remaining} left)` : ''}. They stay listed and usable meanwhile.`;
  return (
    <Surface as="section" tone={state.status === 'stopped' ? 'warning' : undefined}>
      <p style={{ fontSize: 12 }}>{text}</p>
    </Surface>
  );
}
