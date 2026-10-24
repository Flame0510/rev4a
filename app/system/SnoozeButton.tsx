'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Button, showToast } from '../components/ui';

/**
 * Snooze state for a list of spend alarms: one request runs at a time, and every button of the list is
 * disabled while it does. `run(target)` posts to /api/alerts/snooze and then calls `onDone` (the list
 * reloads, so the server's `snoozedUntil` is what the buttons show).
 */
export function useSnooze(onDone: () => void) {
  const [running, setRunning] = useState<string | null>(null);
  const run = async (target: string) => {
    if (running) return;
    setRunning(target);
    try {
      const res = await apiFetch('/api/alerts/snooze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: target, hours: 24 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      showToast('Spend alarms snoozed for 24 hours', 'success');
      onDone();
    } catch (e: any) {
      showToast(e?.message || 'Could not snooze', 'error');
    } finally {
      setRunning(null);
    }
  };
  return { running, run };
}

/**
 * "Snooze 24 h" for a spend alarm, or "Snoozed until <time>" once the server says it is snoozed.
 * `target` is the agent (or `vendor:<name>`) the snooze keys on.
 */
export function SnoozeButton({ target, snoozedUntil, running, onSnooze, timeZone }: {
  target: string;
  snoozedUntil?: number | null;
  /** The target whose request is running, if any: it shows the loading state and every button is disabled. */
  running: string | null;
  onSnooze: (target: string) => void;
  timeZone?: string;
}) {
  const snoozed = typeof snoozedUntil === 'number' && snoozedUntil > Date.now();
  const until = snoozed
    ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(snoozedUntil))
    : '';
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      loading={running === target}
      disabled={running !== null || snoozed}
      onClick={() => onSnooze(target)}
    >
      {running === target ? 'Snoozing…' : snoozed ? `Snoozed until ${until}` : 'Snooze 24 h'}
    </Button>
  );
}
