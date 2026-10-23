import { NextResponse } from 'next/server';
import { isValidAgentId } from '@/lib/container';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { runDocker } from '@/lib/agent-images';
import { forgetBackupAvailability } from '@/lib/agent-update';

export const dynamic = 'force-dynamic';

const BACKUP_VOLUME = 'rev4a-backups';

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
 * List available backups for an agent.
 */
export async function GET(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

    const prefix = `agent-${id}-`;

    // $PREFIX stays unquoted so the shell expands the glob; the id is validated, so
    // the pattern carries no shell metacharacters. The archive name reaches the
    // command through the environment, never as shell syntax.
    const lines: string[] = [];
    let failed: unknown = null;
    await runDocker(
      ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, 'alpine', 'sh', '-c',
        'stat -c "%s %Y %n" /backup/$PREFIX*.tar.gz 2>/dev/null || true'],
      { timeoutMs: 30_000, env: { PREFIX: prefix }, onLine: (line) => lines.push(line.trim()) },
    ).catch((e) => { failed = e; });
    // A failed list must not read as "no backups": under load the container start has
    // been seen to pass 10 s, and an empty array would look like an empty volume.
    if (failed) {
      return NextResponse.json({ error: `Could not list backups: ${(failed as Error).message}` }, { status: 502 });
    }

    const backups: BackupFile[] = [];

    for (const line of lines) {
      // Alpine stat -c "%s %Y %n" format: 12345 1711234567 /backup/agent-prometheus-2026-07-11_2151.tar.gz
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      const sizeBytes = parseInt(parts[0], 10) || 0;
      const epoch = parseInt(parts[1], 10) || 0;
      const fullPath = parts.slice(2).join(' ');
      const name = fullPath.replace(/^\/backup\//, '');
      if (!name || !name.startsWith(prefix) || !name.endsWith('.tar.gz')) continue;
      const d = new Date(epoch * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      backups.push({
        name,
        sizeBytes,
        size: fmtSize(sizeBytes),
        date,
        epoch,
      });
    }

    // Most recent first — sort by the file's real mtime, not by filename order
    // (backup names are not purely chronological: e.g. agent-<id>-prerecreate-<ts>).
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
 * The file name reaches the container through its environment, never as shell
 * syntax, and the name is validated against a strict character set first: only
 * `agent-<id>-<timestamp>.tar.gz` shapes are accepted.
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
    if (!file.startsWith(`agent-${id}-`) || !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(file)) {
      return NextResponse.json({ error: 'Invalid backup file name' }, { status: 400 });
    }

    await runDocker(
      ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, 'alpine', 'sh', '-c', 'rm -f "/backup/$FILE"'],
      { timeoutMs: 30_000, env: { FILE: file } },
    );

    // The panel's rollback offer depends on this file: forget what it knew about it.
    forgetBackupAvailability(id);
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
