import { NextResponse } from 'next/server';
import { isValidAgentId } from '@/lib/container';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { BackupsMigratingError, deleteBackupFile, listAgentBackups } from '@/lib/backups-volume';
import { isValidBackupFile } from '@/lib/backups';
import { forgetBackupAvailability } from '@/lib/agent-update';

export const dynamic = 'force-dynamic';

/** Convert bytes to human-readable size. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface BackupFile {
  name: string;
  size: string;
  sizeBytes: number;
  date: string;
  epoch: number;
}

/**
 * GET /api/agents/[id]/backup
 * List available backups for an agent (files in <data>/backups, plus the legacy volume until migrated).
 */
export async function GET(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

    // Plain files in <data>/backups, merged with the legacy rev4a-backups volume while it still exists.
    // A failed list must not read as "no backups": it answers 502 instead of an empty array.
    let entries;
    try {
      entries = await listAgentBackups(id);
    } catch (e) {
      return NextResponse.json({ error: `Could not list backups: ${(e as Error).message}` }, { status: 502 });
    }

    const pad = (n: number) => String(n).padStart(2, '0');
    const backups: BackupFile[] = entries.map((b) => {
      const d = new Date(b.epoch * 1000);
      return {
        name: b.name,
        sizeBytes: b.sizeBytes,
        size: fmtSize(b.sizeBytes),
        date: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
        epoch: b.epoch,
      };
    });

    // Most recent first, by the file's real mtime (backup names are not purely chronological).
    backups.sort((a, b) => b.epoch - a.epoch);

    return NextResponse.json({ backups });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[id]/backup?file=agent-xxx-2026-07-11_2115.tar.gz
 * Remove a specific backup file.
 *
 * The name is validated against a strict character set first (only
 * `agent-<id>-<timestamp>.tar.gz` shapes) and joined to the backups directory by the server;
 * no path from the request is ever used. The file is removed with plain file calls.
 * 409 while the backups migration is copying files out of the legacy volume (nothing is deleted then).
 */
export async function DELETE(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

    const url = new URL(request.url);
    const file = url.searchParams.get('file');
    if (!file) return NextResponse.json({ error: 'file query param required' }, { status: 400 });

    // Only this agent's archives, and only those shapes; no separators, no `..`,
    // nothing that could carry shell syntax.
    if (!isValidBackupFile(id, file)) {
      return NextResponse.json({ error: 'Invalid backup file name' }, { status: 400 });
    }

    try {
      await deleteBackupFile(file);
    } catch (e) {
      if (e instanceof BackupsMigratingError) return NextResponse.json({ error: e.message }, { status: 409 });
      throw e;
    }

    // The panel's rollback offer depends on this file: forget what it knew about it.
    forgetBackupAvailability(id);
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
