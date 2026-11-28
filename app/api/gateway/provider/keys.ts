import * as fs from 'fs';
import { PROVIDER_KEYS_FILE } from '@/lib/rev4a-paths';
import * as path from 'path';

const KEYS_PATH = PROVIDER_KEYS_FILE;
// Keep a BOM visible to JSON.parse, as in the startup key seeder.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface ProviderKeys {
  [provider: string]: string;
}

type ProviderKeysSnapshot =
  | { keys: ProviderKeys; state: 'ok'; raw: Buffer }
  | { keys: ProviderKeys; state: 'missing' };

type LoadedProviderKeys = ProviderKeysSnapshot | { keys: ProviderKeys; state: 'unreadable' };

export class ProviderKeysChangedError extends Error {
  constructor() {
    super('provider-keys.json changed while saving. Try again.');
    this.name = 'ProviderKeysChangedError';
  }
}

export class ProviderKeysUnreadableError extends Error {
  constructor() {
    super('provider-keys.json could not be read. Fix or remove the file, then try again.');
    this.name = 'ProviderKeysUnreadableError';
  }
}

let lastWarning: string | undefined;

function ensureDir(): void {
  const dir = path.dirname(KEYS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Best-effort: files written before 0600 was enforced are world-readable. */
function tightenMode(): void {
  try {
    const st = fs.statSync(KEYS_PATH);
    if (st.isFile() && (st.mode & 0o077) !== 0) fs.chmodSync(KEYS_PATH, 0o600);
  } catch { /* absent, or not ours to change */ }
}

function unreadableKeys(reason: string): LoadedProviderKeys {
  let stat: fs.Stats | undefined;
  try {
    stat = reason === 'dangling link' ? fs.lstatSync(KEYS_PATH) : fs.statSync(KEYS_PATH);
  } catch { /* metadata may also be inaccessible */ }

  const warningState = `${stat?.mtimeMs}:${stat?.size}:${reason}`;
  if (warningState !== lastWarning) {
    lastWarning = warningState;
    console.warn(`[provider-keys] provider-keys.json could not be read (${reason}); keys ignored until it is fixed. Its content was not changed.`);
  }
  return { keys: {}, state: 'unreadable' };
}

export function loadProviderKeys({ migrateMissing = true } = {}): LoadedProviderKeys {
  // The file holds every key: tighten it even when it cannot be parsed.
  tightenMode();
  let raw: Buffer;
  try {
    raw = fs.readFileSync(KEYS_PATH);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return unreadableKeys(code ?? 'EIO');
    try {
      if (fs.lstatSync(KEYS_PATH, { throwIfNoEntry: false })?.isSymbolicLink()) {
        return unreadableKeys('dangling link');
      }
    } catch (statError) {
      return unreadableKeys((statError as NodeJS.ErrnoException).code ?? 'EIO');
    }

    const keys: ProviderKeys = {};
    if (process.env.PROVIDER_DEEPSEEK_API_KEY) keys['deepseek'] = process.env.PROVIDER_DEEPSEEK_API_KEY;
    if (process.env.PROVIDER_OPENROUTER_API_KEY) keys['openrouter'] = process.env.PROVIDER_OPENROUTER_API_KEY;
    if (migrateMissing && Object.keys(keys).length > 0 && !createProviderKeys(keys)) {
      return loadProviderKeys({ migrateMissing: false });
    }
    lastWarning = undefined;
    return { keys, state: 'missing' };
  }

  let decoded: string;
  try {
    decoded = decoder.decode(raw);
  } catch {
    return unreadableKeys('not valid UTF-8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return unreadableKeys('not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unreadableKeys('not a JSON object');
  }

  lastWarning = undefined;
  return { keys: parsed as ProviderKeys, state: 'ok', raw };
}

export function readProviderKeys(): ProviderKeys {
  return loadProviderKeys().keys;
}

function createProviderKeys(keys: ProviderKeys): boolean {
  ensureDir();
  try {
    fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  fs.chmodSync(KEYS_PATH, 0o600);
  return true;
}

export function saveProviderKeys(snapshot: ProviderKeysSnapshot): void {
  if (snapshot.state === 'missing') {
    if (!createProviderKeys(snapshot.keys)) throw new ProviderKeysChangedError();
    return;
  }

  let current: Buffer;
  try {
    current = fs.readFileSync(KEYS_PATH);
  } catch {
    throw new ProviderKeysChangedError();
  }
  if (!current.equals(snapshot.raw)) throw new ProviderKeysChangedError();
  writeProviderKeys(snapshot.keys);
}

export function writeProviderKeys(keys: ProviderKeys): void {
  ensureDir();
  // Every upstream credential and the gateway password live here: owner-only, like
  // the .env file. `mode` applies only when the file is created, so an existing
  // file is tightened explicitly.
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(KEYS_PATH, 0o600);
}
