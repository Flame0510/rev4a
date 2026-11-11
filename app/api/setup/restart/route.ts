/**
 * POST /api/setup/restart
 *
 * Requires a setup code before configuration, normal auth afterwards. Restarts so changes to
 * .env (especially REV4A_PASSWORD) take effect.
 *
 * Restart reloads .env for all services. Password setup itself takes effect
 * immediately; other environment edits still need a restart.
 *
 * Strategy:
 *   1. If running under systemd (rev4a.service), restart via systemctl.
 *   2. Otherwise send SIGTERM to the current process. The parent process
 *      manager (npx rev4a all or a shell wrapper) should restart it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { ENV_FILE } from '@/lib/rev4a-paths';
import { requireAuthIfConfigured } from '@/lib/rev4a-auth';
import { readEnvValue } from '@/lib/env-file';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Requires the operator code during initial setup. Once
  // configured, this triggers a production service restart and must
  // require a valid session like every other privileged route.
  const denied = await requireAuthIfConfigured(request);
  if (denied) return denied;
  try {
    if (!fs.existsSync(ENV_FILE)) {
      return NextResponse.json({ error: '.env file not found' }, { status: 500 });
    }

    const envContent = fs.readFileSync(ENV_FILE, 'utf-8');
    if (!readEnvValue(envContent, 'REV4A_PASSWORD')) {
      return NextResponse.json(
        { error: 'REV4A_PASSWORD is empty or missing in .env' },
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
          execSync('sudo systemctl restart rev4a.service', { timeout: 15000 });
        } catch (err) {
          console.error('[setup/restart] systemd restart failed:', err);
        }
      }, 2000);
    } else {
      // Dev mode / container: send SIGTERM after flushing response.
      // The parent (npx rev4a all or shell) will restart the process,
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
