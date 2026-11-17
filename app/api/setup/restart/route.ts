/**
 * POST /api/setup/restart
 *
 * Requires a setup code before configuration, normal auth afterwards. Restarts so changes to
 * .env (especially REV4A_PASSWORD) take effect.
 *
 * Restart reloads .env for all services. Password setup itself takes effect
 * immediately; other environment edits still need a restart.
 *
 * Uses the shared restart helper; never terminates only the server.
 */
import { after, NextResponse, type NextRequest } from 'next/server';
import * as fs from 'fs';
import { prepareRestart, RestartUnavailable } from '@/lib/rev4a-restart';
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

    const restart = prepareRestart();
    const response = NextResponse.json({ status: 'ok', restarting: true, mode: restart.mode });
    after(() => {
      try { restart.run(); } catch (error) { console.error('[setup/restart] restart failed:', error); }
    });

    return response;
  } catch (e: unknown) {
    if (e instanceof RestartUnavailable) return NextResponse.json({ error: e.message }, { status: 409 });
    console.error('[setup/restart]', e);
    return NextResponse.json({ error: 'Failed to restart' }, { status: 500 });
  }
}
