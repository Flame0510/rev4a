/**
 * Config → Environment Variables API
 *
 * GET  /api/config/env  — read all env vars (values unmasked)
 * PUT  /api/config/env  — upsert one or more env vars
 *
 * Only keys prefixed with REV4A_ or PROVIDER_ are exposed.
 * Auth: requireAuthJWT (browser cookie or bearer token). proxy.ts does not authenticate /api/*,
 * but its update guard and origin guard (cross-site writes) do run on it.
 */
import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { ENV_FILE } from '@/lib/rev4a-paths';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { applyEnvEdits, assertEnvKey, assertEnvValue, parseEnvValues, RUNTIME_ONLY_ENV_KEYS } from '@/lib/env-file';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_PREFIXES = ['REV4A_', 'PROVIDER_'];

function isAllowedKey(key: string): boolean {
  return !RUNTIME_ONLY_ENV_KEYS.includes(key) && ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

function parseEnvFile(content: string): Record<string, string> {
  return Object.fromEntries(Object.entries(parseEnvValues(content)).filter(([key]) => isAllowedKey(key)));
}

export async function GET(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  try {
    let content = '';
    try {
      content = fs.readFileSync(ENV_FILE, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const vars = parseEnvFile(content);
    // Include inherited settings, but never per-process state or credentials.
    for (const key of Object.keys(process.env).filter((k) => isAllowedKey(k) && !(k in vars))) {
      vars[key] = process.env[key] || '';
    }
    return NextResponse.json({ env: vars });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  try {
    const body: { env?: Record<string, unknown> } | null = await request.json();
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

    // Preserve every line not edited, including comments, unknown keys and line endings.
    let content = '';
    try {
      content = fs.readFileSync(ENV_FILE, 'utf-8');
    } catch (e) {
      // Only a missing file permits starting fresh; never overwrite unreadable data.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    const current = parseEnvFile(content);
    if (entries.some(([key, value]) => !(key in current) && value === '' && process.env[key])) {
      return NextResponse.json(
        { error: 'This value comes from the service environment, not .env; change it there.' },
        { status: 400 },
      );
    }
    // Check stored values first: an old client's unchanged empty or multiline value
    // must not remove a line or fail the validation applied to new assignments.
    // A key absent from the file whose value equals the running one was injected by GET, not edited.
    const changes = entries.filter(([key, value]) => (key in current)
      ? value !== current[key]
      : value !== '' && value !== (process.env[key] ?? ''));
    let next = content;
    let updated: string[] = [];
    try {
      for (const [key, value] of changes) assertEnvValue(key, value);
      if (changes.length > 0) ({ content: next, updated } = applyEnvEdits(content, changes as Array<[string, string]>));
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'NOT_PLAIN_ENV') return NextResponse.json({ error: err.message }, { status: 409 });
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (next === content) {
      // Nothing to write, but a loose mode is still tightened (the file holds secrets).
      try { if ((fs.statSync(ENV_FILE).mode & 0o077) !== 0) fs.chmodSync(ENV_FILE, 0o600); } catch { /* missing: nothing to protect */ }
      return NextResponse.json({ status: 'ok', updated: [] });
    }
    fs.writeFileSync(ENV_FILE, next, { encoding: 'utf-8', mode: 0o600 });
    // The save succeeded; a file owned by another user cannot be chmod-ed: warn, do not fail it.
    try { fs.chmodSync(ENV_FILE, 0o600); } catch (e) { console.warn('[config/env] could not tighten .env to 0600:', (e as NodeJS.ErrnoException).code); }

    // Reload systemd so EnvironmentFile= picks up .env changes on next restart.
    // No need to write individual Environment= lines into unit files —
    // rev4a.service already reads .env via EnvironmentFile=.
    try {
      execSync('sudo systemctl daemon-reload', { timeout: 5000 });
    } catch (syncErr) {
      console.warn('Failed to reload systemd:', syncErr);
    }

    return NextResponse.json({ status: 'ok', updated });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
