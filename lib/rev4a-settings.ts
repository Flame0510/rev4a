/**
 * Rev4a application settings, kept in REV4A_DATA/settings.json (`{ "timezone"?: string }`).
 * The file is optional: a missing, unreadable or invalid one reads as "nothing saved" and never
 * throws. The directory is a parameter so tests can use a temp dir (the route passes REV4A_DATA).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface Rev4aSettings {
  timezone?: string;
}

/** Where the old Tools page kept the time zone (host path, VPS layout). Imported once, never written. */
export const LEGACY_SETTINGS_FILE = '/data/rev4a/settings.json';

export function settingsFile(dir: string): string {
  return path.join(dir, 'settings.json');
}

/** Every IANA zone this runtime knows, plus 'UTC' (some runtimes leave it out of the list). */
export function supportedTimezones(): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
  } catch { /* old runtime: only UTC is accepted */ }
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

/**
 * The canonical spelling of a zone the runtime knows (`europe/rome` -> `Europe/Rome`,
 * `utc` -> `UTC`), or null. Offsets such as "+01:00" are not zone names.
 */
export function canonicalTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 100) return null;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function isValidTimezone(value: unknown): value is string {
  return canonicalTimezone(value) !== null;
}

/** The server's own zone; 'UTC' when it is unavailable or reported as UTC. */
export function serverTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz !== 'UTC' ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Written through a temp file and a rename, mode 0644. */
function writeSettings(dir: string, settings: Rev4aSettings): void {
  const file = settingsFile(dir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf-8', mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/**
 * One-time import: when the new file is absent and the legacy one holds a valid zone, copy it.
 * Never throws; a failed import just leaves the server default in place.
 */
function importLegacy(dir: string, legacyFile: string): Rev4aSettings | null {
  try {
    if (fs.existsSync(settingsFile(dir))) return null;
    const legacy = readJsonObject(legacyFile);
    if (!legacy || !isValidTimezone(legacy.timezone)) return null;
    const imported: Rev4aSettings = { timezone: canonicalTimezone(legacy.timezone) ?? legacy.timezone };
    writeSettings(dir, imported);
    return imported;
  } catch {
    return null;
  }
}

export function readSettings(dir: string, legacyFile: string = LEGACY_SETTINGS_FILE): Rev4aSettings {
  const imported = importLegacy(dir, legacyFile);
  if (imported) return imported;
  const raw = readJsonObject(settingsFile(dir));
  return raw && isValidTimezone(raw.timezone) ? { timezone: canonicalTimezone(raw.timezone) ?? raw.timezone } : {};
}

export type TimezoneSource = 'saved' | 'env' | 'server';

/**
 * The zone every page uses: the saved one, else REV4A_TIMEZONE when it is a valid zone, else
 * the server's own. `env` is a parameter for tests.
 */
export function readTimezone(
  dir: string,
  legacyFile: string = LEGACY_SETTINGS_FILE,
  env: string | undefined = process.env.REV4A_TIMEZONE,
): { timezone: string; source: TimezoneSource } {
  const saved = readSettings(dir, legacyFile).timezone;
  if (saved) return { timezone: saved, source: 'saved' };
  if (isValidTimezone(env)) return { timezone: env, source: 'env' };
  return { timezone: serverTimezone(), source: 'server' };
}

/**
 * Forget the saved zone (back to the default). Other keys in the file are kept. The file is
 * always written, even when it did not exist: its presence is what stops the legacy import.
 */
export function clearTimezone(dir: string): void {
  const { timezone: _removed, ...rest } = readJsonObject(settingsFile(dir)) ?? {};
  writeSettings(dir, rest as Rev4aSettings);
}

/** `timezone` must be valid (see isValidTimezone); it is stored canonicalised. Other keys are kept. */
export function writeTimezone(dir: string, timezone: string): string {
  const canonical = canonicalTimezone(timezone);
  if (!canonical) throw new Error('timezone is not valid');
  const existing = readJsonObject(settingsFile(dir)) ?? {};
  writeSettings(dir, { ...existing, timezone: canonical });
  return canonical;
}
