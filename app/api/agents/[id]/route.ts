import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveAgentedContainer, isValidAgentId } from '@/lib/container';
import { agentBusyReason } from '@/lib/agent-busy';
import { agentEditView, EditRefusedError, startAgentEdit } from '@/lib/agent-edit';
import { DB_FILE } from '@/lib/rev4a-paths';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { deleteAssignmentsForAgent } from '@/lib/credentials/assignments';

const BACKUP_VOLUME = 'rev4a-backups';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
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

    const busy = await agentBusyReason(id);
    if (busy) return NextResponse.json({ error: busy }, { status: 409 });

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

    // The agent is gone with its volume, so no credential can be switched off on it any more.
    // A new agent with the same name must not receive the old token at its first re-apply.
    try {
      const dropped = deleteAssignmentsForAgent(containerName, id);
      if (dropped > 0) console.info(`[credentials] dropped ${dropped} assignment(s) of deleted agent ${containerName}`);
    } catch (e) {
      console.warn(`[credentials] assignments of deleted agent ${containerName} not dropped:`, (e as Error).message);
    }

    // Log event to events.db if it exists
    try {
      const Database = require('better-sqlite3');
      const dbPath = DB_FILE;
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

/**
 * PATCH /api/agents/[id]
 *
 * Edit an agent's display name and/or port range. The container is rebuilt on the image
 * it already runs — **no backup**, the persistent volume is never touched — and the job
 * runs in the background (`lib/agent-edit.ts`): `202` once it has started, then
 * `GET /api/agents/[id]` reports the running or last edit so the panel can resume.
 * While it runs, anything else that would touch the agent answers `409`.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent ID required' }, { status: 400 });
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

    let body: { displayName?: string; portRange?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const rowId = await startAgentEdit(id, { displayName: body.displayName, portRange: body.portRange });
    return NextResponse.json({ started: true, id: rowId }, { status: 202 });
  } catch (e: unknown) {
    if (e instanceof EditRefusedError) {
      const message = e.message;
      // The shared port validator's messages (lib/agent-ports.ts) are validation errors:
      // they answer 400, like the create route. Everything else is a busy refusal (409).
      const status = /Invalid agent id|Display name must not be empty|No fields to update|Invalid format|Ports must be between|End port must be greater|reserved for Rev4a|already in use|Use a number/.test(message)
        ? 400
        : 409;
      return NextResponse.json({ error: message }, { status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * GET /api/agents/[id]
 *
 * The running or last edit of an agent (`null` when it was never edited): what the edit
 * panel polls to resume after a reload.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { id } = await params;
  if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
  return NextResponse.json({ edit: agentEditView(id) }, { headers: { 'Cache-Control': 'no-store' } });
}



