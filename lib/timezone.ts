/**
 * The dashboard time zone. It is saved in Rev4a's data dir (GET/PUT /api/settings) and
 * defaults to the server's own zone. This file is imported by client code: until the setting
 * arrives (or when it cannot be read) every caller uses fallbackRev4aTimezone(), the browser's zone.
 */
export const DEFAULT_REV4A_TIMEZONE = 'UTC';

let timezoneCache: string | null = null;
let timezonePromise: Promise<string> | null = null;

/** Before the setting arrives (or when it cannot be read): this device's own zone, else UTC. One answer for every caller. */
export function fallbackRev4aTimezone(): string {
  try {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (own) return own;
  } catch { /* fall through */ }
  return DEFAULT_REV4A_TIMEZONE;
}

const knownZones = new Set<string>();

/**
 * A zone this runtime can format with. The server checks a saved zone against ITS tzdata; a
 * browser with an older one may not know it, and Intl would throw in the header clock.
 */
function runtimeKnowsZone(value: string): boolean {
  if (knownZones.has(value)) return true;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    knownZones.add(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeRev4aTimezone(value: unknown): string {
  return typeof value === 'string' && value && runtimeKnowsZone(value) ? value : fallbackRev4aTimezone();
}

const FAILURE_BACKOFF_MS = 60_000;
let failedAt = 0;

export async function fetchRev4aTimezone(): Promise<string> {
  if (timezoneCache) return timezoneCache;
  // After a failure, answer with the fallback and do not ask again for a minute.
  if (failedAt && Date.now() - failedAt < FAILURE_BACKOFF_MS) return fallbackRev4aTimezone();
  if (!timezonePromise) {
    timezonePromise = fetch('/api/settings', {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { timezone?: string };
        const timezone = normalizeRev4aTimezone(data.timezone);
        timezoneCache = timezone;
        failedAt = 0;
        for (const l of listeners) l(timezone);
        return timezone;
      })
      .catch(() => {
        failedAt = Date.now();
        return fallbackRev4aTimezone();
      })
      .finally(() => {
        timezonePromise = null;
      });
  }
  return timezonePromise;
}

const listeners = new Set<(timezone: string) => void>();

/** The zone once it has been loaded or saved; null before that. */
export function getCachedRev4aTimezone(): string | null {
  return timezoneCache;
}

/** Calls `listener` whenever the zone changes; returns the unsubscribe function. */
export function subscribeRev4aTimezone(listener: (timezone: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Call after the zone was saved or reset: pages already mounted re-render with it. */
export function updateCachedRev4aTimezone(timezone: string): void {
  failedAt = 0;
  timezoneCache = normalizeRev4aTimezone(timezone);
  for (const l of listeners) l(timezoneCache);
}

export function formatDateTimeInTimezone(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions,
  timezone: string = fallbackRev4aTimezone(),
  locale = 'it-IT',
): string {
  return new Date(value).toLocaleString(locale, {
    ...options,
    timeZone: normalizeRev4aTimezone(timezone),
  });
}
