import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

/**
 * Centralised Rev4a data directory.
 *
 * Cross-platform policy:
 *   Linux/macOS: ~/.config/rev4a/
 *   Windows:     %APPDATA%/rev4a/
 *
 * All persistent files live here so npm reinstall / update
 * never destroys configuration, databases, or secrets.
 */
function rev4aDataDir(): string {
  if (process.env.REV4A_DATA_DIR) return process.env.REV4A_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'rev4a');
  }
  return path.join(os.homedir(), '.config', 'rev4a');
}

export const REV4A_DATA = rev4aDataDir();

/* ── File locations ─────────────────────────────────────────────── */

/** Persistent environment file (~/.config/rev4a/.env) */
export const ENV_FILE = path.join(REV4A_DATA, '.env');

/** SQLite events database */
export const DB_FILE = path.join(REV4A_DATA, 'data', 'events.db');

/** Credentials vault database */
export const CREDENTIALS_DB = path.join(REV4A_DATA, 'data', 'credentials.db');

/** Shared gateway token for agent containers */
export const AGENTS_TOKEN_FILE = path.join(REV4A_DATA, 'data', 'agents-token.json');

/** Provider API keys JSON */
export const PROVIDER_KEYS_FILE = path.join(REV4A_DATA, 'data', 'provider-keys.json');

/** Model overrides JSON */
export const MODELS_CONFIG_FILE = path.join(REV4A_DATA, 'models.config.json');

/** Top-level .next build directory (kept inside npm package for now — built by rev4a serve) */
export function nextDir(pkgRoot: string): string {
  return path.join(pkgRoot, '.next');
}

/** Agent template directory (inside npm package — read-only) */
export function templatesDir(pkgRoot: string): string {
  return path.join(pkgRoot, 'agent-templates');
}

/** Docker base image dir */
export function dockerfileDir(pkgRoot: string): string {
  return path.join(pkgRoot, 'agent-templates', 'base-image');
}

/* ── Helpers ────────────────────────────────────────────────────── */

/** Ensure the data directory tree exists. */
export function ensurePaths(): void {
  for (const dir of [REV4A_DATA, path.dirname(ENV_FILE), path.dirname(DB_FILE)]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Read REV4A_* env vars from the persistent .env file.
 * Returns a plain object suitable for spreading into child process env.
 */
export function loadEnvVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!fs.existsSync(ENV_FILE)) return vars;

  const content = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key.startsWith('REV4A_') || key.startsWith('PROVIDER_')) {
      vars[key] = val;
    }
  }
  return vars;
}

/**
 * Write a key-value pair to the persistent .env file.
 * Replaces existing value for the same key, appends if missing.
 */
export function writeEnvVar(key: string, value: string): void {
  ensurePaths();
  let content = '';
  if (fs.existsSync(ENV_FILE)) {
    content = fs.readFileSync(ENV_FILE, 'utf-8');
  }

  const lines = content.split('\n');
  let found = false;
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`${key}=${value}`);
  }

  fs.writeFileSync(ENV_FILE, updated.join('\n').trim() + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });

  // Also set in process.env so current process picks it up immediately
  process.env[key] = value;
}
