/**
 * POST /api/setup/password
 *
 * No auth required. Sets the admin password on first run.
 * Refuses if a password is already configured.
 *
 * Body: { password: string }
 *
 * After setting, restarts the server via systemd so the new
 * password takes effect immediately.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  // Only allow if no password is configured yet
  const currentPassword = process.env.OLYMPUS_PASSWORD;
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
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }

  try {
    const envFile = path.join(process.cwd(), '.env');

    if (fs.existsSync(envFile)) {
      // Update existing .env
      let content = fs.readFileSync(envFile, 'utf-8');
      if (content.includes('OLYMPUS_PASSWORD=')) {
        content = content.replace(
          /^OLYMPUS_PASSWORD=.*$/m,
          `OLYMPUS_PASSWORD=${body.password}`,
        );
      } else {
        content += `\nOLYMPUS_PASSWORD=${body.password}\n`;
      }
      fs.writeFileSync(envFile, content, 'utf-8');
    } else {
      // Create new .env
      fs.writeFileSync(envFile, `OLYMPUS_PASSWORD=${body.password}\n`, 'utf-8');
    }

    // Schedule a restart (fire-and-forget — the response goes out first)
    setTimeout(() => {
      exec('systemctl restart olympus', (err) => {
        if (err) console.error('[setup/password] restart failed:', err.message);
      });
    }, 1000);

    return NextResponse.json({ status: 'ok', message: 'Password set. Server restarting...' });
  } catch (e: unknown) {
    console.error('[setup/password]', e);
    return NextResponse.json({ error: 'Failed to write password' }, { status: 500 });
  }
}
