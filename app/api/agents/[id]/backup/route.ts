import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { isValidAgentId } from '@/lib/container';

export const dynamic = 'force-dynamic';

const BACKUP_VOLUME = 'rev4a-backups';

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

/** Format a timestamp as YYYY-MM-DD_HHmmssSSS (ms precision avoids same-second collisions). */
function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${ms}`;
}

/** Convert bytes to human-readable size. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

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
  epoch: number;
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
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

    const prefix = `agent-${id}-`;

    const raw = execSync(
      `docker run --rm -v ${BACKUP_VOLUME}:/backup alpine sh -c 'stat -c "%s %Y %n" /backup/${prefix}*.tar.gz 2>/dev/null || true'`,
      { timeout: 10000, encoding: 'utf-8' },
    ).trim();

    const lines = raw.split('\n').filter(Boolean);
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
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

    const url = new URL(req.url);
    const file = url.searchParams.get('file');
    if (!file) return NextResponse.json({ error: 'file query param required' }, { status: 400 });

    // Safety: only allow deleting agent-specific files, reject path traversal
    if (!file.startsWith(`agent-${id}-`) || !file.endsWith('.tar.gz') || file.includes('/') || file.includes('..')) {
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
