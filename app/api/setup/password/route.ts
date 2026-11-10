/**
 * POST /api/setup/password
 *
 * Requires the operator setup code. Sets the admin password on first run.
 * Refuses if a password is already configured.
 * Also generates a random JWT secret and API token if missing.
 *
 * Body: { password: string }
 *
 * Does NOT restart the server — the password takes effect immediately.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ENV_FILE } from '@/lib/rev4a-paths';
import { isConfigured, requireAuthIfConfigured } from '@/lib/rev4a-auth';
import { applyEnvEdits, assertEnvValue, hasEnvAssignment } from '@/lib/env-file';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function generateSecret(len: number): string {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

export async function POST(request: Request): Promise<NextResponse> {
  if (isConfigured()) {
    return NextResponse.json(
      { error: 'Password is already configured. Use the Config page to change it.' },
      { status: 409 },
    );
  }

  const denied = await requireAuthIfConfigured(request);
  if (denied) return denied;

  let body: { password?: unknown } | null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body?.password) {
    return NextResponse.json({ error: 'REV4A_PASSWORD is required' }, { status: 400 });
  }
  try {
    assertEnvValue('REV4A_PASSWORD', body?.password);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  if (body.password.length < 8) {
    return NextResponse.json(
      { error: 'Password must be at least 8 characters' },
      { status: 400 },
    );
  }

  try {
    // Ensure parent directory exists
    const dir = path.dirname(ENV_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let content = '';
    try {
      content = fs.readFileSync(ENV_FILE, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    const edits: Array<[string, string]> = [['REV4A_PASSWORD', body.password]];
    if (!hasEnvAssignment(content, 'REV4A_JWT_SECRET')) edits.push(['REV4A_JWT_SECRET', generateSecret(64)]);
    if (!hasEnvAssignment(content, 'REV4A_TOKEN')) edits.push(['REV4A_TOKEN', generateSecret(32)]);
    try {
      // One physical line per assignment, values written so every reader gets them back intact.
      ({ content } = applyEnvEdits(content, edits));
    } catch (e) {
      const err = e as Error & { code?: string };
      return NextResponse.json({ error: err.message }, { status: err.code === 'NOT_PLAIN_ENV' ? 409 : 400 });
    }

    // No await between the fresh file read above, this check and the write. A request
    // paused reading its body cannot replace the password another request just set.
    if (isConfigured()) {
      return NextResponse.json(
        { error: 'Password is already configured. Use the Config page to change it.' },
        { status: 409 },
      );
    }
    fs.writeFileSync(ENV_FILE, content, { encoding: 'utf-8', mode: 0o600 });
    try { fs.chmodSync(ENV_FILE, 0o600); } catch (e) { console.warn('[setup/password] could not tighten .env to 0600:', (e as NodeJS.ErrnoException).code); }

    // Update in-memory so proxy redirects work before restart
    process.env.REV4A_PASSWORD = body.password;

    return NextResponse.json({ status: 'ok' });
  } catch (e: unknown) {
    console.error('[setup/password]', e);
    return NextResponse.json({ error: 'Failed to write password' }, { status: 500 });
  }
}
