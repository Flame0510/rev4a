import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';

const BACKUP_VOLUME = 'olympus-backups';

/**
 * Determine the volume name for an agent by checking if it exists.
 */
function agentVolumeName(agentName: string): string | null {
  try {
    const vols = execSync(
      "docker volume ls --format '{{.Name}}'",
      { encoding: 'utf-8', timeout: 5000 },
    ).trim().split('\n').filter(Boolean);
    const needle = `agent-${agentName}-data`;
    return vols.includes(needle) ? needle : null;
  } catch {
    return null;
  }
}

/** Format a timestamp as YYYY-MM-DD_HHmmss (second precision avoids same-minute collisions). */
function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Convert bytes to human-readable size. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * POST /api/agents/[id]/backup
 * Create a backup of the agent's persistent volume.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });

    const volume = agentVolumeName(id);
    if (!volume) {
      return NextResponse.json({ error: `No persistent volume found for agent '${id}'` }, { status: 404 });
    }

    const filename = `agent-${id}-${ts()}.tar.gz`;

    execSync(
      `docker run --rm ` +
      `-v ${volume}:/source:ro ` +
      `-v ${BACKUP_VOLUME}:/backup ` +
      `alpine sh -c 'tar czf /backup/${filename} --exclude=.npm/_cacache -C /source . && chmod 644 /backup/${filename}'`,
      { timeout: 60000, stdio: 'pipe' },
    );

    return NextResponse.json({ success: true, file: filename });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

interface BackupFile {
  name: string;
  size: string;
  sizeBytes: number;
  date: string;
}

/**
 * GET /api/agents/[id]/backup
 * List available backups for an agent.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });

    const prefix = `agent-${id}-`;

    const raw = execSync(
      `docker run --rm -v ${BACKUP_VOLUME}:/backup alpine sh -c 'ls -la /backup/ 2>/dev/null || true'`,
      { timeout: 10000, encoding: 'utf-8' },
    ).trim();

    const lines = raw.split('\n').filter(Boolean);
    const backups: BackupFile[] = [];

    for (const line of lines) {
      // Alpine ls -la format: -rw-r--r--    1 root     root       12345 Jul 11 19:25 filename.tar.gz
      const parts = line.split(/\s+/);
      const name = parts[parts.length - 1];
      if (!name || !name.startsWith(prefix) || !name.endsWith('.tar.gz')) continue;
      const sizeBytes = parseInt(parts[4], 10) || 0;
      const month = parts[5] || '';
      const day = parts[6] || '';
      const time = parts[7] || '';
      backups.push({
        name,
        sizeBytes,
        size: fmtSize(sizeBytes),
        date: `${month} ${day} ${time}`,
      });
    }

    // Most recent first
    backups.reverse();

    return NextResponse.json({ backups });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[id]/backup?file=agent-xxx-2026-07-11_2115.tar.gz
 * Remove a specific backup file.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });

    const url = new URL(req.url);
    const file = url.searchParams.get('file');
    if (!file) return NextResponse.json({ error: 'file query param required' }, { status: 400 });

    // Safety: only allow deleting agent-specific files
    if (!file.startsWith(`agent-${id}-`) || !file.endsWith('.tar.gz')) {
      return NextResponse.json({ error: 'Invalid backup file name' }, { status: 400 });
    }

    execSync(
      `docker run --rm -v ${BACKUP_VOLUME}:/backup alpine sh -c 'rm -f /backup/${file}'`,
      { timeout: 10000, stdio: 'pipe' },
    );

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
