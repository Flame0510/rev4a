/**
 * POST /api/setup/restart
 *
 * No auth required. Syncs password from .env to systemd service
 * and restarts the Olympus service.
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
    let password = '';

    // Read current password from .env
    if (fs.existsSync(envFile)) {
      const envContent = fs.readFileSync(envFile, 'utf-8');
      for (const line of envContent.split('\n')) {
        const match = line.match(/^OLYMPUS_PASSWORD=(.*)$/);
        if (match) {
          password = match[1].trim();
          break;
        }
      }
    }

    // Sync to systemd service file
    if (password) {
      try {
        const servicePath = '/etc/systemd/system/olympus.service';
        let svcContent = fs.readFileSync(servicePath, 'utf-8');

        // Remove any existing OLYMPUS_PASSWORD lines
        svcContent = svcContent.split('\n')
          .filter((l) => !l.trim().startsWith('Environment=OLYMPUS_PASSWORD='))
          .join('\n');

        // Add password line before [Install]
        svcContent = svcContent.replace(
          '[Install]',
          'Environment=OLYMPUS_PASSWORD=' + password + '\n\n[Install]',
        );

        // Write to a unique temp file to avoid /tmp race conditions
        const tmpPath = `/tmp/olympus.service.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        fs.writeFileSync(tmpPath, svcContent, { encoding: 'utf-8', mode: 0o600 });
        execSync(`sudo cp "${tmpPath}" /etc/systemd/system/olympus.service`, { timeout: 5000 });
        try { fs.unlinkSync(tmpPath); } catch {}
      } catch (syncErr) {
        console.error('[setup/restart] systemd sync failed:', syncErr);
      }
    }

    execSync('sudo systemctl daemon-reload', { timeout: 5000 });

    // Clone the response so we can send headers before the restart kills the process.
    // The 2000ms delay gives Next.js time to flush the response to the client.
    const response = NextResponse.json({ status: 'ok', restarting: true });

    setTimeout(() => {
      try {
        execSync('sudo systemctl restart olympus', { timeout: 5000 });
      } catch (err) {
        console.error('[setup/restart] restart failed:', err);
      }
    }, 2000);

    return response;
  } catch (e: unknown) {
    console.error('[setup/restart]', e);
    return NextResponse.json({ error: 'Failed to restart' }, { status: 500 });
  }
}
