/**
 * POST /api/setup/restart
 *
 * No auth required. Restarts the Olympus server so that changes to
 * .env (especially OLYMPUS_PASSWORD) take effect.
 *
 * Next.js inlines env vars at build time, so a runtime process.env
 * mutation is not enough — the process must restart to reload .env.
 *
 * Strategy:
 *   1. If running under systemd (olympus.target), restart via systemctl.
 *   2. Otherwise send SIGTERM to the current process. The parent process
 *      manager (npx olympus all or a shell wrapper) should restart it.
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

    if (!fs.existsSync(envFile)) {
      return NextResponse.json({ error: '.env file not found' }, { status: 500 });
    }

    const envContent = fs.readFileSync(envFile, 'utf-8');
    const match = envContent.match(/^OLYMPUS_PASSWORD=(.*)$/m);
    if (!match || !match[1].trim()) {
      return NextResponse.json(
        { error: 'OLYMPUS_PASSWORD is empty or missing in .env' },
        { status: 400 },
      );
    }

    // Try systemd first (production).
    // If it fails, fall back to SIGTERM (dev mode / container).
    let usedSystemd = false;
    try {
      execSync('sudo systemctl daemon-reload', { timeout: 5000 });
      usedSystemd = true;
    } catch {
      // systemctl not available — fine, we'll SIGTERM
    }

    const response = NextResponse.json({
      status: 'ok',
      restarting: true,
      mode: usedSystemd ? 'systemd' : 'process',
    });

    if (usedSystemd) {
      setTimeout(() => {
        try {
          execSync('sudo systemctl restart olympus.target', { timeout: 15000 });
        } catch (err) {
          console.error('[setup/restart] systemd restart failed:', err);
        }
      }, 2000);
    } else {
      // Dev mode / container: send SIGTERM after flushing response.
      // The parent (npx olympus all or shell) will restart the process,
      // which will re-read .env at startup.
      setTimeout(() => {
        process.kill(process.pid, 'SIGTERM');
      }, 2000);
    }

    return response;
  } catch (e: unknown) {
    console.error('[setup/restart]', e);
    return NextResponse.json({ error: 'Failed to restart' }, { status: 500 });
  }
}
