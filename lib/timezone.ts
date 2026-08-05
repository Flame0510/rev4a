export const DEFAULT_REV4A_TIMEZONE = 'Europe/Rome';

let timezoneCache: string | null = null;
let timezonePromise: Promise<string> | null = null;

export function normalizeRev4aTimezone(value: unknown): string {
  return typeof value === 'string' && value ? value : DEFAULT_REV4A_TIMEZONE;
}

export async function fetchRev4aTimezone(): Promise<string> {
  if (timezoneCache) return timezoneCache;
  if (!timezonePromise) {
    timezonePromise = fetch('/api/tools-config', {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { timezone?: string };
        const timezone = normalizeRev4aTimezone(data.timezone);
        timezoneCache = timezone;
        return timezone;
      })
      .catch(() => DEFAULT_REV4A_TIMEZONE)
      .finally(() => {
        timezonePromise = null;
      });
  }
  return timezonePromise;
}

export function setCachedRev4aTimezone(timezone: string): void {
  timezoneCache = normalizeRev4aTimezone(timezone);
}

export function formatDateTimeInTimezone(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions,
  timezone = DEFAULT_REV4A_TIMEZONE,
  locale = 'it-IT',
): string {
  return new Date(value).toLocaleString(locale, {
    ...options,
    timeZone: normalizeRev4aTimezone(timezone),
  });
}
