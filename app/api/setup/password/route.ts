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
import { ENV_FILE } from '@/lib/olympus-paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function generateSecret(len: number): string {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

export async function POST(request: Request): Promise<NextResponse> {
  // Check both env and .env file (same fallback pattern as login/status routes)
  let currentPassword = process.env.OLYMPUS_PASSWORD;
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    try {
      if (fs.existsSync(ENV_FILE)) {
        const content = fs.readFileSync(ENV_FILE, 'utf-8');
        const match = content.match(/^OLYMPUS_PASSWORD=(.+)$/m);
        if (match && match[1].trim()) {
          currentPassword = match[1].trim();
        }
      }
    } catch { /* ignore */ }
  }
  if (typeof currentPassword === 'string' && currentPassword.length > 0) {
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

    // Ensure password line
    if (content.includes('OLYMPUS_PASSWORD=')) {
      content = content
        .split('\n')
        .map((line) =>
          line.startsWith('OLYMPUS_PASSWORD=')
            ? 'OLYMPUS_PASSWORD=' + body.password
            : line,
        )
        .join('\n');
    } else {
      content += '\nOLYMPUS_PASSWORD=' + body.password + '\n';
    }

    // Generate JWT secret if missing
    if (!content.includes('OLYMPUS_JWT_SECRET=')) {
      const secret = generateSecret(64);
      content += '\nOLYMPUS_JWT_SECRET=' + secret + '\n';
    }

    // Generate API token if missing
    if (!content.includes('OLYMPUS_TOKEN=')) {
      const token = generateSecret(32);
      content += '\nOLYMPUS_TOKEN=' + token + '\n';
    }

    fs.writeFileSync(ENV_FILE, content.trim() + '\n', { encoding: 'utf-8', mode: 0o600 });

    // Update in-memory so proxy redirects work before restart
    process.env.OLYMPUS_PASSWORD = body.password;

    return NextResponse.json({ status: 'ok' });
  } catch (e: unknown) {
    console.error('[setup/password]', e);
    return NextResponse.json({ error: 'Failed to write password' }, { status: 500 });
  }
}
