/**
 * POST /api/setup/password
 *
 * No auth required. Sets the admin password on first run.
 * Refuses if a password is already configured.
 *
 * Body: { password: string }
 *
 * Does NOT restart the server — the password takes effect
 * after the full setup wizard completes and the server restarts.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
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
      let content = fs.readFileSync(envFile, 'utf-8');
      if (content.includes('OLYMPUS_PASSWORD=')) {
        content = content.replace(
          /^OLYMPUS_PASSWORD=…/m,
          `OLYMPUS_PASSWORD=${body.password}`,
        );
      } else {
        content += `\nOLYMPUS_PASSWORD=${body.password}\n`;
      }
      fs.writeFileSync(envFile, content, 'utf-8');
    } else {
      fs.writeFileSync(envFile, `OLYMPUS_PASSWORD=***\n`, 'utf-8');
    }

    return NextResponse.json({ status: 'ok' });
  } catch (e: unknown) {
    console.error('[setup/password]', e);
    return NextResponse.json({ error: 'Failed to write password' }, { status: 500 });
  }
}
