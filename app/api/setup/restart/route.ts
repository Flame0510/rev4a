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

        fs.writeFileSync('/tmp/olympus.service.tmp', svcContent, 'utf-8');
        execSync('sudo cp /tmp/olympus.service.tmp /etc/systemd/system/olympus.service', { timeout: 5000 });
        try { fs.unlinkSync('/tmp/olympus.service.tmp'); } catch {}
      } catch (syncErr) {
        console.error('[setup/restart] systemd sync failed:', syncErr);
      }
    }

    execSync('sudo systemctl daemon-reload', { timeout: 5000 });

    // Send response first, then restart
    const response = NextResponse.json({ status: 'ok', restarting: true });

    setTimeout(() => {
      try {
        execSync('sudo systemctl restart olympus', { timeout: 5000 });
      } catch (err) {
        console.error('[setup/restart] restart failed:', err);
      }
    }, 500);

    return response;
  } catch (e: unknown) {
    console.error('[setup/restart]', e);
    return NextResponse.json({ error: 'Failed to restart' }, { status: 500 });
  }
}
