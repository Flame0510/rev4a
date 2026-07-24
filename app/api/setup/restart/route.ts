/**
 * POST /api/setup/restart
 *
 * No auth required. Syncs password from .env to the Next.js service
 * environment, then restarts the entire Olympus target via systemd.
 *
 * In systemd deployments, the service reads EnvironmentFile=.env
 * at startup — so we restart olympus.target to pick up changes.
 * No manual inlining of Environment= lines needed.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  try {
    const envFile = path.join(process.cwd(), '.env');

    // Verify .env exists and has a non-empty password
    if (!fs.existsSync(envFile)) {
      return NextResponse.json({ error: '.env file not found' }, { status: 500 });
    }

    const envContent = fs.readFileSync(envFile, 'utf-8');
    const match = envContent.match(/^OLYMPUS_PASSWORD=(.+)$/m);
    if (!match || !match[1].trim()) {
      return NextResponse.json(
        { error: 'OLYMPUS_PASSWORD is empty or missing in .env' },
        { status: 400 },
      );
    }

    // Reload systemd and restart the entire target.
    // EnvironmentFile=.env in olympus-next.service picks up the new password.
    execSync('sudo systemctl daemon-reload', { timeout: 5000 });

    // Deferred restart so the HTTP response can flush before the service dies
    const response = NextResponse.json({ status: 'ok', restarting: true });

    setTimeout(() => {
      try {
        execSync('sudo systemctl restart olympus.target', { timeout: 15000 });
      } catch (err) {
        console.error('[setup/restart] olympus.target restart failed:', err);
      }
    }, 2000);

    return response;
  } catch (e: unknown) {
    console.error('[setup/restart]', e);
    return NextResponse.json({ error: 'Failed to restart' }, { status: 500 });
  }
}
