import * as fs from 'fs';
import { PROVIDER_KEYS_FILE } from '@/lib/rev4a-paths';
import * as path from 'path';

const KEYS_PATH = PROVIDER_KEYS_FILE;

interface ProviderKeys {
  [provider: string]: string;
}

function ensureDir(): void {
  const dir = path.dirname(KEYS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Best-effort: files written before 0600 was enforced are world-readable. */
function tightenMode(): void {
  try {
    if ((fs.statSync(KEYS_PATH).mode & 0o077) !== 0) fs.chmodSync(KEYS_PATH, 0o600);
  } catch { /* absent, or not ours to change */ }
}

export function readProviderKeys(): ProviderKeys {
  ensureDir();
  tightenMode();
  try {
    const raw = fs.readFileSync(KEYS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    // File doesn't exist — try to migrate from env
    const keys: ProviderKeys = {};
    if (process.env.PROVIDER_DEEPSEEK_API_KEY) keys['deepseek'] = process.env.PROVIDER_DEEPSEEK_API_KEY;
    if (process.env.PROVIDER_OPENROUTER_API_KEY) keys['openrouter'] = process.env.PROVIDER_OPENROUTER_API_KEY;
    if (Object.keys(keys).length > 0) {
      writeProviderKeys(keys);
    }
    return keys;
  }
}

export function writeProviderKeys(keys: ProviderKeys): void {
  ensureDir();
  // Every upstream credential and the gateway password live here: owner-only, like
  // the .env file. `mode` applies only when the file is created, so an existing
  // file is tightened explicitly.
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(KEYS_PATH, 0o600);
}
