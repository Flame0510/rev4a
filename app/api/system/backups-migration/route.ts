import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { backupsMigrationStatus } from '@/lib/backups-migration-host';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/backups-migration
 * State of the move of old backups from the Docker volume `rev4a-backups` into
 * `<data>/backups`: `pending`, `running`, `done` or `stopped` (with a `reason`).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    return NextResponse.json(await backupsMigrationStatus());
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
