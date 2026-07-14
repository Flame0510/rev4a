/**
 * POST /api/config/restart - restart the olympus service via systemd
 */
import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { syncAllAgents } from '../../gateway/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  try {
    // Sync agent config BEFORE restart so they pick up any domain/env changes.
    // Must happen before restart because restart kills this process.
    try {
      syncAllAgents();
    } catch {
      // best-effort, non-fatal
    }

    execSync('sudo systemctl daemon-reload && sudo systemctl restart olympus', {
      timeout: 15000,
      stdio: 'pipe',
    });

    return NextResponse.json({ status: 'ok', message: 'Service restarted' });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: 'error', message: msg }, { status: 500 });
  }
}
