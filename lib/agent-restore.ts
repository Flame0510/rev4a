/**
 * Restoring an agent's volume from a backup archive.
 *
 * The volume is cleared and the archive extracted into it — minutes for a large
 * workspace — then the container is started again even when the extract failed. The
 * job is recorded in `agent_restores` and runs in the background, so a page reload or
 * a Rev4a restart never loses track of it and a second restore cannot start on top of
 * the first (lib/agent-busy.ts answers 409 while one runs).
 */
import { isValidAgentId } from '@/lib/container';
import { runDocker } from '@/lib/agent-images';
import { BACKUP_VOLUME } from '@/lib/cold-backup';
import { inspectAgentContainer } from '@/lib/agent-recreate';
import { activeRestoreAgentIds, insertRestore, isRestoreActive, latestRestore, markInterruptedRestores, updateRestoreRow, type AgentRestoreRow } from '@/lib/agent-restore-state';
import { agentBusyReason } from '@/lib/agent-busy';

/** A 13 GB workspace takes minutes to decompress; 30 minutes leaves room and still ends. */
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;

export class RestoreRefusedError extends Error {}

/** Archive names are `<agent>-<something>.tar.gz`; nothing that could carry shell syntax. */
function isValidBackupFile(agentId: string, file: string): boolean {
  return file.startsWith(`agent-${agentId}-`) && /^[A-Za-z0-9._-]+\.tar\.gz$/.test(file);
}

/** Restore jobs running in this process, so a second start for the same agent is refused. */
const running = new Set<string>();

export async function startAgentRestore(agentId: string, file: string): Promise<number> {
  if (!isValidAgentId(agentId)) throw new RestoreRefusedError('Invalid agent id');
  if (!isValidBackupFile(agentId, file)) throw new RestoreRefusedError('Invalid backup file name');
  if (running.has(agentId) || isRestoreActive(agentId)) throw new RestoreRefusedError('A restore of this agent is already running');
  // Claimed synchronously, before the first await, so two requests cannot both pass.
  running.add(agentId);
  try {
    // One source for every long operation: an update, recreate, restore, edit or backup.
    const busy = await agentBusyReason(agentId);
    if (busy) throw new RestoreRefusedError(busy);

    // The archive must exist before anything is stopped or cleared. It used to be
    // shape-checked only, so a file that had been pruned or deleted made the job wipe
    // the volume and then fail, leaving the agent on an empty volume.
    await runDocker(
      ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, 'alpine', 'sh', '-c', 'test -f "/backup/$FILE"'],
      { timeoutMs: 30_000, env: { FILE: file } },
    ).catch(() => {
      throw new RestoreRefusedError(`Backup file '${file}' not found`);
    });

    const id = insertRestore(agentId, file);
    void runRestore(id, agentId, file).finally(() => running.delete(agentId));
    return id;
  } catch (e) {
    running.delete(agentId);
    throw e;
  }
}

async function runRestore(id: number, agentId: string, file: string): Promise<void> {
  const container = await inspectAgentContainer(agentId).catch(() => null);
  const name = container?.Name?.replace(/^\//, '');
  try {
    if (name && container?.State?.Running) {
      await runDocker(['stop', '-t', '30', name], { timeoutMs: 45_000 }).catch(() => {});
    }

    // Clear the volume, then extract. The file name reaches the container through its
    // environment and the whole command is one argv element, so it is never shell syntax.
    await runDocker(
      [
        'run', '--rm',
        '-v', `agent-${agentId}-data:/target`,
        '-v', `${BACKUP_VOLUME}:/backup`,
        'alpine', 'sh', '-c',
        'test -f "/backup/$FILE" || exit 3; rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null; tar xzf "/backup/$FILE" -C /target',
      ],
      { timeoutMs: EXTRACT_TIMEOUT_MS, env: { FILE: file } },
    );

    updateRestoreRow(id, { status: 'done' });
  } catch (e) {
    updateRestoreRow(id, { status: 'failed', error: (e as Error)?.message ?? String(e) });
  } finally {
    // The container is started again even when the extract failed, so the agent never
    // stays down. A volume with no container (volume-only agent) has nothing to start.
    if (name) {
      await runDocker(['start', name], { timeoutMs: 60_000 }).catch(() => {});
    }
  }
}

export interface AgentRestoreView {
  id: number;
  agentId: string;
  status: AgentRestoreRow['status'];
  file: string | null;
  error: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

/** The latest restore of an agent, so the panel can resume after a reload. */
export function agentRestoreView(agentId: string): AgentRestoreView | null {
  const row = latestRestore(agentId);
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    file: row.file,
    error: row.error,
    startedAtMs: row.started_at,
    finishedAtMs: row.finished_at,
  };
}

/**
 * At startup no restore job can be running: rows still active were cut off by the
 * restart. They become `interrupted`; a container left stopped is started again,
 * best-effort, so nothing stays down.
 */
export async function recoverInterruptedRestores(): Promise<number> {
  const ids = activeRestoreAgentIds();
  if (ids.size === 0) return 0;
  const interrupted = markInterruptedRestores();
  for (const agentId of ids) {
    const container = await inspectAgentContainer(agentId).catch(() => null);
    const name = container?.Name?.replace(/^\//, '');
    if (name && !container?.State?.Running) {
      await runDocker(['start', name], { timeoutMs: 60_000 }).catch(() => {});
    }
  }
  return interrupted;
}
