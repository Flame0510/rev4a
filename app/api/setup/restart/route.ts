/**
 * POST /api/setup/restart
 *
 * No auth required. Restarts the Olympus service via systemd.
 * Called at the end of the setup wizard to apply all changes
 * (password, provider keys, etc.) at once.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  try {
    // Sync password from .env to systemd service if needed
    const envFile = path.join(process.cwd(), '.env');
    if (fs.existsSync(envFile)) {
      const envContent = fs.readFileSync(envFile, 'utf-8');
      const passwordMatch = envContent.match(/^OLYMPUS_PASSWORD=(.+)$/m);
      if (passwordMatch) {
        const password = passwordMatch[1].trim();
        const servicePath = '/etc/systemd/system/olympus.service';

        try {
          let svcContent = fs.readFileSync(servicePath, 'utf-8');
          // Remove existing OLYMPUS_PASSWORD lines
          svcContent = svcContent.replace(/^Environment=OLYMPUS_PASSWORD=…\n?/gm, '');
          // Add before [Install]
          svcContent = svcContent.replace(
            /^\[Install\]$/m,
            'Environment=OLYMPUS_PASSWORD=' + password + '\n[Install]',
          );
          fs.writeFileSync('/tmp/olympus.service.tmp', svcContent, 'utf-8');
          execSync('sudo cp /tmp/olympus.service.tmp /etc/systemd/system/olympus.service', { timeout: 5000 });
          fs.unlinkSync('/tmp/olympus.service.tmp');
        } catch {
          // .env is enough — skip systemd sync
        }
      }
    }

    execSync('sudo systemctl daemon-reload', { timeout: 5000 });

    // Send response before restart
    const response = NextResponse.json({ status: 'ok', message: 'Restarting...' });

    setTimeout(() => {
      try {
        execSync('sudo systemctl restart olympus', { timeout: 5000 });
      } catch (err) {
        console.error('[setup/restart] restart failed:', err);
      }
    }, 300);

    return response;
  } catch (e: unknown) {
    console.error('[setup/restart]', e);
    return NextResponse.json({ error: 'Failed to restart' }, { status: 500 });
  }
}
