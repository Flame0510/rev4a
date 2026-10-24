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
import { backupMountSource } from '@/lib/backups-volume';
import { isValidBackupFile } from '@/lib/backups';
import { inspectAgentContainer, startAndVerifyContainer } from '@/lib/agent-recreate';
import { activeRestoreAgentIds, insertRestore, isRestoreActive, latestRestore, markInterruptedRestores, updateRestoreRow, type AgentRestoreRow } from '@/lib/agent-restore-state';
import { agentBusyReason } from '@/lib/agent-busy';
import { reapplyWhenReady } from '@/lib/credentials/delivery';

/** A 13 GB workspace takes minutes to decompress; 30 minutes leaves room and still ends. */
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;

export class RestoreRefusedError extends Error {}

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
    // The archive is in the backups folder, or still in the legacy volume while the migration runs.
    const source = await backupMountSource(file).catch(() => null);
    if (!source) throw new RestoreRefusedError(`Backup file '${file}' not found`);

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
  let failure: string | null = null;
  try {
    if (name && container?.State?.Running) {
      await runDocker(['stop', '-t', '30', name], { timeoutMs: 45_000 }).catch(() => {});
    }

    // Where the archive is now (the migration may have moved it since the check).
    const source = await backupMountSource(file);
    if (!source) throw new Error(`Backup file '${file}' not found`);

    // Clear the volume, then extract. The file name reaches the container through its
    // environment and the whole command is one argv element, so it is never shell syntax.
    await runDocker(
      [
        'run', '--rm',
        '-v', `agent-${agentId}-data:/target`,
        '-v', `${source}:/backup:ro`,
        'alpine', 'sh', '-c',
        'test -f "/backup/$FILE" || exit 3; rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null; tar xzf "/backup/$FILE" -C /target',
      ],
      { timeoutMs: EXTRACT_TIMEOUT_MS, env: { FILE: file } },
    );
  } catch (e) {
    failure = (e as Error)?.message ?? String(e);
  } finally {
    // The container is started again even when the extract failed, so the agent never
    // stays down. The row is only `done` when it really came back: a container can
    // report running while its network never attached, which is not a usable agent.
    if (name) {
      const started = await startAndVerifyContainer(agentId, name);
      if (!started.ok) {
        const note = `the container did not come back: ${started.error}`;
        failure = failure ? `${failure}; ${note}` : `the volume was restored, but ${note}`;
      } else {
        void reapplyWhenReady(name).catch((e) => console.warn(`[restore] credential re-apply failed on ${name}:`, (e as Error).message));
      }
    }
    if (failure) updateRestoreRow(id, { status: 'failed', error: failure });
    else updateRestoreRow(id, { status: 'done' });
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
 * restart. A restore interrupted **mid-extract** leaves a half-written volume, so
 * starting the container would present a partial workspace as if it were the restore: the
 * extract is run again from the same archive (it is the source of truth and the file was
 * checked before the job started), in the background, and the row lands in its final
 * status. When the archive is gone the container is started on whatever the volume holds,
 * and the row says so.
 */
export async function recoverInterruptedRestores(): Promise<number> {
  const ids = activeRestoreAgentIds();
  if (ids.size === 0) return 0;
  const interrupted = markInterruptedRestores();
  for (const agentId of ids) {
    const row = latestRestore(agentId);
    const name = (await inspectAgentContainer(agentId).catch(() => null))?.Name?.replace(/^\//, '');
    if (row?.file && (await backupFileExists(agentId, row.file))) {
      console.log(`[agent:restore] ${agentId}: re-running the interrupted restore from ${row.file}`);
      void runRestore(row.id, agentId, row.file).finally(() => undefined);
      continue;
    }
    if (!name) continue;
    const started = await startAndVerifyContainer(agentId, name);
    if (!started.ok) console.warn(`[agent:restore] ${agentId} did not come back after an interrupted restore: ${started.error}`);
  }
  return interrupted;
}

/** Whether the archive still exists (backups folder, or the legacy volume until it is migrated). */
async function backupFileExists(agentId: string, file: string): Promise<boolean> {
  if (!isValidBackupFile(agentId, file)) return false;
  try {
    return (await backupMountSource(file)) !== null;
  } catch {
    return false;
  }
}
