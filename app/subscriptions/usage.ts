/** Shared by the Subscriptions page and the agent panel: the shape and wording of the usage limits. */

export interface UsageWindow { label: string; usedPercent: number; resetAt: string | null }
export interface UsageAccount { email: string | null; plan: string | null; windows: UsageWindow[]; updatedAt: string | null }
export interface UsageResponse { accounts: UsageAccount[]; errors: { email: string | null; message: string }[] }

export function windowTitle(label: string): string {
  if (/^5\s*h/i.test(label)) return '5 hours';
  if (/^(week|weekly)$/i.test(label)) return 'Weekly';
  return label;
}

/** Short form for the agent panel line: "5h", "week". */
export function windowShort(label: string): string {
  if (/^5\s*h/i.test(label)) return '5h';
  if (/^(week|weekly)$/i.test(label)) return 'week';
  return label.toLowerCase();
}

export function usageTone(percent: number): 'ok' | 'warning' | 'critical' {
  if (percent >= 100) return 'critical';
  if (percent >= 80) return 'warning';
  return 'ok';
}

/** "09:45" when the reset is today, "Thu 15 Oct, 09:45" later, in the viewer's local time. */
export function formatReset(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}

/** The reset of the window that is at its limit, for the "Limit reached" lines. */
export function reachedWindow(account: UsageAccount): UsageWindow | null {
  return account.windows.find((w) => w.usedPercent >= 100) ?? null;
}

export function agoText(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Updated just now';
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min) || min < 1) return 'Updated just now';
  if (min < 60) return `Updated ${min} min ago`;
  return `Updated ${Math.floor(min / 60)} h ago`;
}
