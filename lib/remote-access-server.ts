/** Server-only reads. Only these three non-secret settings may reach the preset UI. */
import * as fs from 'fs';
import { ENV_FILE } from '@/lib/rev4a-paths';
import { parseEnvValues } from '@/lib/env-file';
import type { AccessSettings } from './remote-access';

/** Environment writes never mutate process.env; these are the settings this boot loaded. */
export function startupAccessSettings(): AccessSettings {
  return Object.fromEntries(['REV4A_LISTEN', 'REV4A_AGENT_PORTS_LISTEN', 'REV4A_TRUSTED_PROXIES'].map((key) => [key, process.env[key] || '']));
}

export function readAccessSettings(): AccessSettings {
  let content = '';
  try { content = fs.readFileSync(ENV_FILE, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const stored = parseEnvValues(content);
  const fromDotenv = new Set((process.env.REV4A_DOTENV_KEYS || '').split(','));
  return Object.fromEntries(['REV4A_LISTEN', 'REV4A_AGENT_PORTS_LISTEN', 'REV4A_TRUSTED_PROXIES'].map((key) =>
    [key, stored[key] || (!fromDotenv.has(key) ? process.env[key] : '') || '']));
}
