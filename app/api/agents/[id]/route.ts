import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveAgentedContainer, isValidAgentId } from '@/lib/container';

const BACKUP_VOLUME = 'olympus-backups';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;

    if (!id || id.length < 1) {
      return NextResponse.json(
        { success: false, error: 'Container name or ID is required' },
        { status: 400 },
      );
    }
    if (!isValidAgentId(id)) {
      return NextResponse.json({ success: false, error: 'Invalid agent id' }, { status: 400 });
    }

    // Only allow deletion of containers that have a matching AGENT_ID label
    const containerName = resolveAgentedContainer(id);
    if (!containerName) {
      return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });
    }

    execSync(`docker rm -f "${containerName}"`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    // Destructive delete: also remove the persistent volume and all backups.
    // The container is already gone, so the volume is no longer in use.
    // Best-effort — a missing volume or absent backups must not fail the delete.
    try {
      execSync(`docker volume rm agent-${id}-data`, { timeout: 15000, stdio: 'pipe' });
    } catch {
      // volume may not exist (legacy agent) or already removed — ignore
    }
    try {
      execSync(
        `docker run --rm -v ${BACKUP_VOLUME}:/backup alpine sh -c 'rm -f /backup/agent-${id}-*.tar.gz'`,
        { timeout: 20000, stdio: 'pipe' },
      );
    } catch {
      // no backups or backup volume missing — ignore
    }

    // Log event to events.db if it exists
    try {
      const Database = require('better-sqlite3');
      const dbPath = path.join(process.cwd(), 'data', 'events.db');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: false });
        db.pragma('journal_mode = WAL');
        db.prepare(
          `INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, ?)`,
        ).run(Date.now(), `system:agents`, 'agent_deleted', JSON.stringify({
          name: id,
          containerName,
        }));
        db.close();
      }
    } catch {
      // DB logging is optional, ignore failures
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const err = e as Error;
    return NextResponse.json(
      { success: false, error: err.message || 'Unknown error' },
      { status: 500 },
    );
  }
}


