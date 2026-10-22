// Formatting utilities — pure functions, no side effects (apart from asking for the time zone setting once)
import { fallbackRev4aTimezone, fetchRev4aTimezone, getCachedRev4aTimezone } from '@/lib/timezone';

export function formatUsd(value: number | null | undefined): string {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

/** Megabytes as MB, GB or TB with the precision a reader wants: '692 MB', '1.6 GB'. */
export function formatMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return '—';
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(2)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** A CPU share in percent, with the decimals a small figure needs (an idle agent is 0.02 % of Docker's cores). */
export function formatSharePercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '—';
  if (percent === 0) return '0%';
  if (percent < 0.01) return '<0.01%';
  if (percent < 1) return `${percent.toFixed(2)}%`;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/** Bytes per second as B/s, KB/s or MB/s. */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—';
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

/**
 * Dollars with the precision a small figure needs: an agent's day can be a fraction of a
 * cent, which formatUsd would show as $0.00. Used wherever agent costs are shown.
 */
export function formatCost(value: number | null | undefined): string {
  const v = Number(value ?? 0);
  if (!v) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

export function formatUsdOrDash(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  return formatUsd(value);
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const n = Number(value ?? 0);
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

let _timezone: string | null = null;

/** Pins the zone for the next calls (tests, one-off use). The dashboard setting is used otherwise. */
export function setTimeZone(tz: string | null): void {
  _timezone = tz;
}

/**
 * The zone times are shown in: the dashboard setting (Config > Time zone, loaded into the
 * browser's cache by the pages), else REV4A_TIMEZONE where the server runs this, else the
 * browser's zone (the same fallback as the hook), else UTC. In the browser the setting is requested here when it is not
 * loaded yet, so a later call has it.
 */
export function getTimeZone(): string {
  if (_timezone) return _timezone;
  const cached = getCachedRev4aTimezone();
  if (cached) return cached;
  if (typeof window !== 'undefined') {
    void fetchRev4aTimezone();
  } else if (process.env.REV4A_TIMEZONE) {
    return process.env.REV4A_TIMEZONE;
  }
  return fallbackRev4aTimezone();
}

export function formatTimeFromUnixSeconds(ts: number | null | undefined): string {
  if (!ts) return '--:--:--';
  const ms = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  return new Date(ms).toLocaleString(undefined, {
    timeZone: getTimeZone(),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

export function formatDuration(
  startTs: number | null | undefined,
  endTs: number | null | undefined,
): string {
  if (!startTs || !endTs) return '-';
  const start = Number(startTs) < 1e12 ? Number(startTs) * 1000 : Number(startTs);
  const end = Number(endTs) < 1e12 ? Number(endTs) * 1000 : Number(endTs);
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function truncate(value: string | null | undefined, max = 48): string {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function statusColor(status: string | null | undefined): string {
  const s = String(status ?? 'idle').toLowerCase();
  if (s === 'working' || s === 'active') return '#44e18d';
  if (s === 'error') return '#f07070';
  return '#89a1ad';
}

export function parseEventData(data: unknown): string {
  if (!data) return '';
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (typeof parsed === 'string') return parsed;
    return (
      (parsed as Record<string, unknown>)?.message?.toString() ??
      (parsed as Record<string, unknown>)?.text?.toString() ??
      (parsed as Record<string, unknown>)?.event?.toString() ??
      JSON.stringify(parsed)
    );
  } catch {
    return String(data);
  }
}
