/**
 * POST /api/setup/password
 *
 * No auth required. Sets the admin password on first run.
 * Refuses if a password is already configured.
 * Also generates a random JWT secret and API token if missing.
 *
 * Body: { password: string }
 *
 * Does NOT restart the server — the password takes effect
 * after the full setup wizard completes and the server restarts.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ENV_FILE } from '@/lib/rev4a-paths';
import { isConfigured } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function generateSecret(len: number): string {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

/**
 * True only if an actual assignment line for `key` exists — a commented-out
 * or incidental mention (`# old REV4A_TOKEN=…`) does not count. A substring
 * check here would report the key as present and skip generating it, leaving
 * the instance without a usable secret.
 */
function hasEnvKey(content: string, key: string): boolean {
  return content.split('\n').some((line) => line.trimStart().startsWith(`${key}=`));
}

/** Replace the assignment line for `key`, or append one if none exists. */
function upsertEnvLine(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  let replaced = false;
  const updated = lines.map((line) => {
    if (!replaced && line.trimStart().startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) updated.push(`${key}=${value}`);
  return updated.join('\n');
}

export async function POST(request: Request): Promise<NextResponse> {
  if (isConfigured()) {
    return NextResponse.json(
      { error: 'Password is already configured. Use the Config page to change it.' },
      { status: 409 },
    );
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.password || typeof body.password !== 'string') {
    return NextResponse.json({ error: 'password is required' }, { status: 400 });
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
    if (fs.existsSync(ENV_FILE)) {
      content = fs.readFileSync(ENV_FILE, 'utf-8');
    }

    content = upsertEnvLine(content, 'REV4A_PASSWORD', body.password);
    if (!hasEnvKey(content, 'REV4A_JWT_SECRET')) {
      content = upsertEnvLine(content, 'REV4A_JWT_SECRET', generateSecret(64));
    }
    if (!hasEnvKey(content, 'REV4A_TOKEN')) {
      content = upsertEnvLine(content, 'REV4A_TOKEN', generateSecret(32));
    }

    fs.writeFileSync(ENV_FILE, content.trim() + '\n', { encoding: 'utf-8', mode: 0o600 });

    // Update in-memory so proxy redirects work before restart
    process.env.REV4A_PASSWORD = body.password;

    return NextResponse.json({ status: 'ok' });
  } catch (e: unknown) {
    console.error('[setup/password]', e);
    return NextResponse.json({ error: 'Failed to write password' }, { status: 500 });
  }
}
