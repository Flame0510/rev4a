/**
 * GET /api/agents/activity-summary
 *
 * The long operation each agent is in the middle of, if any — the chip on the agent
 * cards: `BACKUP nn%`, `RESTORING`, `RECREATING`, `UPDATING`.
 *
 * One Docker list call plus, per running cold backup, its status read. Idle agents are
 * not listed at all, so an idle system costs one call.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { coldBackupStatus, listRunningColdBackups } from '@/lib/cold-backup';
import { activeRestoreAgentIds, latestRestore } from '@/lib/agent-restore-state';
import { activeRecreateAgentIds, latestRecreate } from '@/lib/agent-recreate-state';
import { activeUpdateAgentIds, latestUpdate } from '@/lib/agent-update-state';
import { activeEditAgentIds, latestEdit } from '@/lib/agent-edit-state';

export const dynamic = 'force-dynamic';

export type AgentActivityKind = 'backup' | 'restore' | 'recreate' | 'update' | 'edit';

interface AgentActivity {
  agentId: string;
  kind: AgentActivityKind;
  file?: string | null;
  version?: string | null;
  percent?: number | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;

  const byAgent = new Map<string, AgentActivity>();

  // Update and recreate first: a running cold backup then overrides them, because while
  // its helper archives the volume that is the phase actually in progress.
  for (const agentId of activeUpdateAgentIds()) {
    const row = latestUpdate(agentId);
    if (row && (row.status === 'migrating' || row.status === 'verifying' || row.status === 'rolling_back')) {
      byAgent.set(agentId, { agentId, kind: 'update', version: row.to_version });
    }
  }
  for (const agentId of activeRecreateAgentIds()) {
    const row = latestRecreate(agentId);
    if (row && row.status === 'recreating') {
      byAgent.set(agentId, { agentId, kind: 'recreate', version: row.image });
    }
  }
  for (const agentId of activeRestoreAgentIds()) {
    byAgent.set(agentId, { agentId, kind: 'restore', file: latestRestore(agentId)?.file ?? null });
  }
  for (const agentId of activeEditAgentIds()) {
    const row = latestEdit(agentId);
    if (row && row.status === 'rebuilding') {
      byAgent.set(agentId, { agentId, kind: 'edit', file: row.display_name });
    }
  }

  const backupIds = await listRunningColdBackups().catch(() => []);
  await Promise.all(backupIds.map(async (agentId) => {
    const job = await coldBackupStatus(agentId).catch(() => null);
    if (!job || job.status !== 'running') return;
    byAgent.set(agentId, { agentId, kind: 'backup', file: job.file, percent: job.percent });
  }));

  return NextResponse.json({ agents: [...byAgent.values()] }, { headers: { 'Cache-Control': 'no-store' } });
}
