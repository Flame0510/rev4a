/** Server-only shared Config/preset writes: identical validation, preservation and 0600 rules. */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { ENV_FILE } from '@/lib/rev4a-paths';
import { parseSetting } from '@/lib/listen-addresses';
import { applyEnvEdits, assertEnvKey, assertEnvValue, parseEnvValues, RUNTIME_ONLY_ENV_KEYS } from '@/lib/env-file';
import { withFileDirectoryLock } from '@/lib/file-lock';

const ALLOWED_PREFIXES = ['REV4A_', 'PROVIDER_'];
// The root CLI sets paths read by Caddy and written by the supervisor. Keep them operator-managed.
const DOMAIN_SETUP_KEYS = new Set(['REV4A_DOMAIN', 'REV4A_CADDY_FILE', 'REV4A_CADDY_MAIN']);

export function isAllowedKey(key: string): boolean {
  return !RUNTIME_ONLY_ENV_KEYS.includes(key) && !DOMAIN_SETUP_KEYS.has(key) && ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

/** REV4A_LISTEN and REV4A_AGENT_PORTS_LISTEN take empty, all, local or one IP: garbage must not silently become `local`. */
function assertListenSetting(key: string, value: string): void {
  if (key !== 'REV4A_LISTEN' && key !== 'REV4A_AGENT_PORTS_LISTEN') return;
  if (parseSetting(value).kind === 'invalid') {
    throw new TypeError(`${key} must be empty, "all", "local" or one IP address (not 0.0.0.0 or ::). Got ${JSON.stringify(value)}.`);
  }
}

export function parseEnvFile(content: string): Record<string, string> {
  return Object.fromEntries(Object.entries(parseEnvValues(content)).filter(([key]) => isAllowedKey(key)));
}

/** Names of the keys the launcher loaded from .env (names only, never values). */
export function dotenvKeys(): Set<string> {
  return new Set((process.env.REV4A_DOTENV_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean));
}

export async function saveEnvironment(input: unknown, explicit = false): Promise<NextResponse> {
  try {
    const body = input as { env?: Record<string, unknown> } | null;
    if (!body?.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
      return NextResponse.json({ error: 'env object required' }, { status: 400 });
    }

    // Older open tabs may submit per-process keys: ignore them before validation.
    const entries = Object.entries(body.env).filter(([key]) => !RUNTIME_ONLY_ENV_KEYS.includes(key));
    const invalidKeys = entries.map(([key]) => key).filter((k) => !isAllowedKey(k));
    if (invalidKeys.length > 0) {
      return NextResponse.json(
        { error: `Keys not allowed: ${invalidKeys.join(', ')}` },
        { status: 400 },
      );
    }

    try {
      for (const [key] of entries) {
        assertEnvKey(key);
      }
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }

    const save = () => editEnvironment(entries, explicit);
    const result = await (process.platform === 'linux' ? withFileDirectoryLock(ENV_FILE, save, { allowMissingFlock: true }) : save());
    if (result.updated) {
      // The service already uses EnvironmentFile=. Reload outside the file lock.
      try {
        execSync('sudo systemctl daemon-reload', { timeout: 5000 });
      } catch (syncErr) {
        console.warn('Failed to reload systemd:', syncErr);
      }
    }
    return result.response;
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

function editEnvironment(entries: Array<[string, unknown]>, explicit: boolean): { response: NextResponse; updated?: boolean } {
  // Preserve every line not edited, including comments, unknown keys and line endings.
  let content = '';
  try {
    content = fs.readFileSync(ENV_FILE, 'utf-8');
  } catch (e) {
    // Only a missing file permits starting fresh; never overwrite unreadable data.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const current = parseEnvFile(content);
  const fromDotenv = dotenvKeys();
  if (entries.some(([key, value]) => !(key in current) && value === '' && process.env[key] && !fromDotenv.has(key))) {
    return { response: NextResponse.json(
      { error: 'This value comes from the service environment, not .env; change it there.' },
      { status: 400 },
    ) };
  }
  // Check stored values first: an old client's unchanged empty or multiline value
  // must not remove a line or fail the validation applied to new assignments.
  // A key absent from the file whose value equals the running one was injected by GET, not edited.
  const changes = entries.filter(([key, value]) => (key in current)
    ? value !== current[key]
    : value !== '' && (explicit || value !== (process.env[key] ?? '')));
  let next = content;
  let updated: string[] = [];
  try {
    for (const [key, value] of changes) {
      assertEnvValue(key, value);
      assertListenSetting(key, value);
    }
    if (changes.length > 0) ({ content: next, updated } = applyEnvEdits(content, changes as Array<[string, string]>));
  } catch (e) {
    const err = e as Error & { code?: string };
    return { response: NextResponse.json({ error: err.message }, { status: err.code === 'NOT_PLAIN_ENV' ? 409 : 400 }) };
  }
  if (next === content) {
    // Nothing to write, but a loose mode is still tightened (the file holds secrets).
    try { if ((fs.statSync(ENV_FILE).mode & 0o077) !== 0) fs.chmodSync(ENV_FILE, 0o600); } catch { /* missing: nothing to protect */ }
    return { response: NextResponse.json({ status: 'ok', updated: [] }) };
  }
  fs.writeFileSync(ENV_FILE, next, { encoding: 'utf-8', mode: 0o600 });
  // The save succeeded; a file owned by another user cannot be chmod-ed: warn, do not fail it.
  try { fs.chmodSync(ENV_FILE, 0o600); } catch (e) { console.warn('[config/env] could not tighten .env to 0600:', (e as NodeJS.ErrnoException).code); }

  return { response: NextResponse.json({ status: 'ok', updated }), updated: true };
}
