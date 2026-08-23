import { type NextRequest } from "next/server";
/**
 * POST /api/config/restart - restart the rev4a service via systemd
 *
 * Agent sync is handled by instrumentation.ts on startup — no need to sync
 * here (the restart kills this process, and the new process syncs on boot).
 */
import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  try {
    execSync('sudo systemctl daemon-reload && sudo systemctl restart rev4a.service', {
      timeout: 15000,
      stdio: 'pipe',
    });
    return NextResponse.json({ status: 'ok', message: 'Service restarted' });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: 'error', message: msg }, { status: 500 });
  }
}
