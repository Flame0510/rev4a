import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { resolveAgentedContainer, isValidAgentId } from '@/lib/container';

export const dynamic = 'force-dynamic';

const BACKUP_VOLUME = 'rev4a-backups';

/**
 * POST /api/agents/[id]/restore?file=agent-xxx-2026-07-11_2115.tar.gz
 * Restore an agent's persistent volume from a backup.
 * Stops the container, restores the volume, then restarts.
 */
export async function POST(
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

    // Safety: only allow restoring agent-specific files, reject path traversal
    if (!file.startsWith(`agent-${id}-`) || !file.endsWith('.tar.gz') || file.includes('/') || file.includes('..')) {
      return NextResponse.json({ error: 'Invalid backup file name' }, { status: 400 });
    }

    const volume = `agent-${id}-data`;

    // Resolve the actual container name via AGENT_ID label
    const containerName = resolveAgentedContainer(id);

    // Check backup exists
    const check = execSync(
      `docker run --rm -v ${BACKUP_VOLUME}:/backup alpine sh -c 'test -f /backup/${file} && echo ok || true'`,
      { timeout: 10000, encoding: 'utf-8' },
    ).trim();
    if (check !== 'ok') {
      return NextResponse.json({ error: `Backup file '${file}' not found` }, { status: 404 });
    }

    // Stop the container if running
    if (containerName) {
      execSync(`docker stop ${containerName} 2>/dev/null; exit 0`, { timeout: 15000 });
    }

    // Clear the volume and restore from backup.
    // Run a temporary container with the volume, delete ALL contents (including
    // dotfiles/dotdirs like .openclaw, .config, .local — the .[!.]* glob is
    // required, otherwise the restore only merges on top of stale state), then
    // extract the backup. Always restart the container afterwards, even on failure.
    try {
      execSync(
        `docker run --rm ` +
        `-v ${volume}:/target ` +
        `-v ${BACKUP_VOLUME}:/backup ` +
        `alpine sh -c 'rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null; tar xzf /backup/${file} -C /target'`,
        { timeout: 30000, stdio: 'pipe' },
      );
    } finally {
      // Restart the container regardless of extract outcome so it never stays down.
      if (containerName) {
        try {
          execSync(`docker start ${containerName}`, { timeout: 15000, stdio: 'pipe' });
        } catch {
          // container start failure is surfaced separately; nothing else to do here
        }
      }
    }

    return NextResponse.json({ success: true, container: containerName || id });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

