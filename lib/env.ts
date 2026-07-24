/**
 * env.ts — unified .env reader
 *
 * Next.js inlines process.env at build time, so any value written to
 * .env at runtime (by the setup wizard or config changes) is invisible
 * to process.env reads in server components, route handlers, and libs.
 *
 * This module provides a single readEnv(key) function that always reads
 * from the .env file on disk, with process.env as a secondary source.
 */
import * as fs from 'fs';
import * as path from 'path';

function getEnvPath(): string {
  // Prefer OLYMPUS_APP env var (set by systemd unit or olympus CLI),
  // fall back to cwd (works in dev) or /opt/olympus (default production).
  const appDir = process.env.OLYMPUS_APP
    || /* turbopackIgnore: true */ process.cwd();
  return path.join(appDir, '.env');
}

let _cachedContent: string | null = null;
let _cachedMtime = 0;

function readEnvContent(): string {
  try {
    const envPath = getEnvPath();
    if (!fs.existsSync(envPath)) return '';
    const stat = fs.statSync(envPath);
    if (stat.mtimeMs === _cachedMtime && _cachedContent !== null) {
      return _cachedContent;
    }
    _cachedContent = fs.readFileSync(envPath, 'utf-8');
    _cachedMtime = stat.mtimeMs;
    return _cachedContent;
  } catch {
    _cachedContent = '';
    _cachedMtime = 0;
    return '';
  }
}

/**
 * Read a value from the .env file on disk.
 * Falls back to process.env[key] if the file doesn't contain it.
 * This ensures runtime .env changes (via setup wizard, config page)
 * are always picked up.
 */
export function readEnv(key: string): string {
  const content = readEnvContent();
  if (content) {
    const regex = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=(.*)$', 'm');
    const match = content.match(regex);
    if (match && match[1] !== undefined) {
      const val = match[1].trim();
      if (val) return val;
    }
  }
  // Fallback to process.env (works when .env was available at build time)
  const fromProcess = process.env[key];
  return typeof fromProcess === 'string' ? fromProcess : '';
}

/** Convenience: read 'OLYMPUS_PASSWORD' */
export function readPassword(): string {
  return readEnv('OLYMPUS_PASSWORD');
}

/** Convenience: read 'OLYMPUS_JWT_SECRET' */
export function readJwtSecret(): string {
  return readEnv('OLYMPUS_JWT_SECRET');
}

/** Convenience: read 'OLYMPUS_TOKEN' */
export function readToken(): string {
  return readEnv('OLYMPUS_TOKEN');
}
