/** Restore is destructive only after content compatibility and a cold recovery copy are proven. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dockerRequestJson } from '@/lib/docker-socket-path';
import { pipeline } from 'node:stream/promises';
import { isValidAgentId } from '@/lib/container';
import { runDocker, containerOpenClawVersion, listLocalAgentImages } from '@/lib/agent-images';
import { locateBackup } from '@/lib/backups-volume';
import { BACKUPS_DIR } from '@/lib/rev4a-paths';
import { isValidBackupFile } from '@/lib/backups';
import { inspectAgentContainer, startAndVerifyContainer, type AgentContainerInspect } from '@/lib/agent-recreate';
import { markInterruptedRestores, insertRestore, isRestoreActive, latestRestore, updateRestoreRow, type AgentRestoreRow } from '@/lib/agent-restore-state';
import { agentBusyReason } from '@/lib/agent-busy';
import { reapplyWhenReady } from '@/lib/credentials/delivery';
import { startColdBackup, waitForColdBackup, isColdBackupRunning } from '@/lib/cold-backup';
import { waitForGatewayReady } from '@/lib/agent-readiness';
import { inspectBackupArchive, BackupInspectionError, type BackupInspection } from '@/lib/backup-inspection';
import { checkBackupCompatibility } from '@/lib/backup-compatibility';

const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;
const READY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SOURCE_BYTES = 32 * 1024 ** 3;
export class RestoreRefusedError extends Error {}
const restoreGlobals = globalThis as unknown as { __rev4aRunningRestores?: Set<string> };
const running = (restoreGlobals.__rev4aRunningRestores ??= new Set<string>());

interface RestorePlan {
  directory: string;
  container: AgentContainerInspect;
  name: string;
  targetVersion: string;
  inspection: BackupInspection;
}

/** Pin inspected bytes privately; a later replacement/deletion of the listed archive is harmless. */
async function pinBackup(file: string): Promise<string> {
  const where = await locateBackup(file);
  if (where !== 'dir') throw new RestoreRefusedError(where === 'volume'
    ? 'This backup is still in the legacy Docker volume. Wait for the backups migration to finish before restoring.'
    : 'The backup file was not found in the data folder');
  const input = await fsp.open(path.join(BACKUPS_DIR, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    .catch(() => { throw new RestoreRefusedError('The backup must be a readable local regular file'); });
  let directory: string | null = null;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SOURCE_BYTES) throw new RestoreRefusedError('The backup exceeds the safe restore inspection budget');
    directory = await fsp.mkdtemp(path.join(BACKUPS_DIR, '.rev4a-restore-source-'));
    await fsp.chmod(directory, 0o700);
    const capacity = await fsp.statfs(directory);
    if (Number(capacity.bavail) * Number(capacity.bsize) < stat.size + 1024 ** 3) throw new RestoreRefusedError('Not enough temporary disk space to pin and inspect this backup safely');
    await pipeline(
      input.createReadStream({ autoClose: false, start: 0, end: stat.size - 1 }),
      fs.createWriteStream(path.join(directory, 'source.tar.gz'), { flags: 'wx', mode: 0o600 }),
      { signal: AbortSignal.timeout(180_000) },
    );
    return directory;
  } catch (error) {
    if (directory) await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  } finally { await input.close().catch(() => {}); }
}

async function prepareRestore(agentId: string, file: string): Promise<RestorePlan> {
  const directory = await pinBackup(file);
  try {
    const inspection = await inspectBackupArchive(path.join(directory, 'source.tar.gz'));
    const container = await inspectAgentContainer(agentId);
    const name = container?.Name?.replace(/^\//, '');
    if (!container?.Id || !container.Image || !name) throw new RestoreRefusedError('The agent container could not be inspected');
    const targetVersion = await containerOpenClawVersion({ id: container.Id, name, imageId: container.Image, running: container.State?.Running === true }, await listLocalAgentImages());
    const compatible = checkBackupCompatibility(inspection, targetVersion);
    if (!compatible.compatible || !targetVersion) throw new RestoreRefusedError(compatible.reason ?? 'Backup compatibility could not be established');
    return { directory, inspection, container, name, targetVersion };
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function safeFailure(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'REV4A_AGENT_JOB_BUSY') {
    return 'Another lifecycle operation of this agent started; refresh and retry';
  }
  return error instanceof RestoreRefusedError || error instanceof BackupInspectionError
    ? error.message : 'The restore operation failed; inspect the recovery backup before retrying';
}

export async function startAgentRestore(agentId: string, file: string): Promise<number> {
  if (!isValidAgentId(agentId)) throw new RestoreRefusedError('Invalid agent id');
  if (!isValidBackupFile(agentId, file)) throw new RestoreRefusedError('Invalid backup file name');
  if (running.has(agentId) || isRestoreActive(agentId)) throw new RestoreRefusedError('A restore of this agent is already running');
  running.add(agentId);
  let id: number | null = null;
  try {
    const busy = await agentBusyReason(agentId);
    if (busy) throw new RestoreRefusedError(busy);
    const source = await fsp.lstat(path.join(BACKUPS_DIR, file)).catch(() => null);
    if (!source?.isFile()) throw new RestoreRefusedError('The backup is not available as a local regular archive. Wait for the legacy backups migration or select a completed local backup.');
    // Persist the claim before slow inspection so other lifecycle actions see it.
    id = insertRestore(agentId, file);
    updateRestoreRow(id, { phase: 'preflight' });
    void runRestore(id, agentId, file).catch(() => console.warn('[restore] restore state could not be finalized; review the interrupted operation'))
      .finally(() => running.delete(agentId));
    return id;
  } catch (error) {
    if (id !== null) updateRestoreRow(id, { status: 'failed', phase: 'preflight_failed', error: safeFailure(error) });
    running.delete(agentId);
    throw error instanceof RestoreRefusedError ? error : new RestoreRefusedError(safeFailure(error));
  }
}

/** Only a Docker 404 proves absence; a transport failure never releases the volume writer's claim. */
async function inspectRestoreHelper(name: string): Promise<{ Id?: string; Config?: { Labels?: Record<string, string>; Cmd?: string[] }; State?: { Running?: boolean; ExitCode?: number }; Mounts?: { Name?: string; Destination?: string }[] } | null> {
  try { return await dockerRequestJson('GET', `/containers/${encodeURIComponent(name)}/json`, 10_000); }
  catch (error) { if (/^Docker error 404:/.test((error as Error)?.message ?? '')) return null; throw error; }
}

async function removeRestoreHelper(name: string, agentId: string, id: number): Promise<boolean> {
  try {
    const helper = await inspectRestoreHelper(name);
    if (!helper) return true;
    const owned = helper.Config?.Labels?.['rev4a.restore.agent'] === agentId && helper.Config?.Labels?.['rev4a.restore.id'] === String(id);
    if (!owned || helper.Config?.Labels?.AGENT_ID !== undefined) return false;
    // Even a rejected/timed-out remove can have succeeded: the independent inspect decides.
    await runDocker(['stop', '-t', '10', name], { timeoutMs: 20_000 }).catch(() => {});
    await runDocker(['rm', '-f', name], { timeoutMs: 20_000 }).catch(() => {});
    return (await inspectRestoreHelper(name)) === null;
  } catch { return false; }
}

async function stopRestoreAgent(agentId: string, containerId?: string, name?: string): Promise<'stopped' | 'still running' | 'unknown'> {
  if (name) await runDocker(['stop', '-t', '30', name], { timeoutMs: 45_000 }).catch(() => {});
  const current = await inspectAgentContainer(agentId).catch(() => null);
  if (!current || (containerId && current.Id !== containerId) || typeof current.State?.Running !== 'boolean') return 'unknown';
  return current.State.Running ? 'still running' : 'stopped';
}

/** Only delete our own pinned source path, after cleanup has been confirmed. */
async function deleteRestoreSource(directory: string | null | undefined): Promise<void> {
  if (directory && path.dirname(directory) === BACKUPS_DIR && path.basename(directory).startsWith('.rev4a-restore-source-')) {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function runRestore(id: number, agentId: string, file: string): Promise<void> {
  let plan: RestorePlan | null = null;
  let recovery: string | null = null;
  let replacing = false;
  let helperName: string | null = null;
  let helperGone = true;
  let unresolved = false;
  try {
    // Pin, full inspection and SQLite integrity can take minutes. They belong to
    // the persisted background job, and still precede every stop or volume write.
    plan = await prepareRestore(agentId, file);
    updateRestoreRow(id, { source_directory: plan.directory, preflight_json: JSON.stringify({
      archiveSha256: plan.inspection.sha256, configVersion: plan.inspection.configVersion,
      stateSchemaVersion: plan.inspection.stateSchemaVersion, agentSchemaVersions: plan.inspection.agentSchemaVersions,
      targetVersion: plan.targetVersion, containerId: plan.container.Id, imageId: plan.container.Image,
    }) });
    const current = await inspectAgentContainer(agentId);
    if (current?.Id !== plan.container.Id || current?.Image !== plan.container.Image) throw new RestoreRefusedError('The agent container changed after preflight; no volume was replaced');
    updateRestoreRow(id, { phase: 'backing_up' });
    const backup = await startColdBackup(agentId, { kind: 'manual', leaveStopped: true });
    const result = await waitForColdBackup(agentId, { timeoutMs: EXTRACT_TIMEOUT_MS });
    if (result.status !== 'succeeded' || result.file !== backup.file) throw new RestoreRefusedError('The cold recovery backup did not complete; the volume was not replaced');
    recovery = backup.file;
    updateRestoreRow(id, { recovery_file: recovery, phase: 'backed_up' });
    const stopped = await inspectAgentContainer(agentId);
    if (stopped?.Id !== plan.container.Id || stopped?.Image !== plan.container.Image || stopped?.State?.Running) throw new RestoreRefusedError('The agent changed or restarted during backup; no volume was replaced');
    helperName = `rev4a-restore-${agentId}-${id}-${randomUUID()}`;
    updateRestoreRow(id, { phase: 'extracting', helper_name: helperName, source_directory: plan.directory });
    helperGone = false;
    replacing = true;
    await runDocker([
      'create', '--name', helperName, '--label', `rev4a.restore.agent=${agentId}`, '--label', `rev4a.restore.id=${id}`, '--network', 'none',
      '-v', `agent-${agentId}-data:/target`, '-v', `${plan.directory}:/backup:ro`,
      'alpine', 'sh', '-c',
      'test -f /backup/source.tar.gz && find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar xzf /backup/source.tar.gz -C /target',
    ], { timeoutMs: EXTRACT_TIMEOUT_MS });
    await runDocker(['start', '--attach', helperName], { timeoutMs: EXTRACT_TIMEOUT_MS });
    const extracted = await inspectRestoreHelper(helperName);
    if (extracted?.State?.Running !== false || extracted.State.ExitCode !== 0) throw new RestoreRefusedError('The extraction helper did not confirm a successful exit');
    helperGone = await removeRestoreHelper(helperName, agentId, id);
    if (!helperGone) throw new RestoreRefusedError('The extraction helper could not be confirmed gone');
    updateRestoreRow(id, { phase: 'awaiting_ready' });
    const started = await startAndVerifyContainer(agentId, plan.name);
    if (!started.ok || !(await waitForGatewayReady(plan.name, READY_TIMEOUT_MS))) {
      throw new RestoreRefusedError('The restored Gateway did not finish startup');
    }
    void reapplyWhenReady(plan.name).catch(() => console.warn('[restore] credential re-apply failed after Gateway readiness'));
    updateRestoreRow(id, { status: 'done', phase: 'complete' });
    if (process.env.REV4A_DOMAIN?.trim()) {
      void import('@/lib/domain-sync').then(({ syncDomainRoutes }) => syncDomainRoutes())
        .catch(() => console.warn('[domain] Could not load Caddy sync.'));
    }
  } catch (error) {
    let failure = safeFailure(error);
    if (recovery) failure += `; recovery backup: ${recovery}`;
    if (replacing && plan) {
      if (helperName && !helperGone) helperGone = await removeRestoreHelper(helperName, agentId, id);
      const state = await stopRestoreAgent(agentId, plan.container.Id, plan.name);
      failure += state === 'unknown' ? '; agent state is unknown' : `; agent is ${state}`;
      unresolved = !helperGone || state !== 'stopped';
      failure += '; do not use partial data: restore the recovery backup after cleanup or review the current volume';
      if (unresolved) failure += `; helper: ${helperName ?? 'not recorded'}; cleanup unresolved: the volume remains reserved; pinned source retained; resolve this restore in Agents > Backups`;
    }
    else if (plan?.container.State?.Running && !(await isColdBackupRunning(agentId).catch(() => true))) {
      const current = await inspectAgentContainer(agentId).catch(() => null);
      if (current?.Id === plan.container.Id && current?.State?.Running === false) {
        await startAndVerifyContainer(agentId, plan.name).catch(() => undefined);
        // The daemon may have removed the agent's route while it was stopped.
        if (process.env.REV4A_DOMAIN?.trim()) {
          void import('@/lib/domain-sync').then(({ syncDomainRoutes }) => syncDomainRoutes())
            .catch(() => console.warn('[domain] Could not load Caddy sync.'));
        }
      }
    }
    updateRestoreRow(id, { status: unresolved ? 'unresolved' : 'failed', phase: unresolved ? 'cleanup_unresolved' : replacing ? 'replacement_failed' : plan ? 'backup_failed' : 'preflight_failed', error: failure });
  } finally {
    if (plan && helperGone && !unresolved) await deleteRestoreSource(plan.directory);
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
  phase: string | null;
  recoveryFile: string | null;
  preflight: unknown | null;
}
export function agentRestoreView(agentId: string): AgentRestoreView | null {
  const row = latestRestore(agentId);
  let preflight: unknown | null = null;
  try { preflight = row?.preflight_json ? JSON.parse(row.preflight_json) : null; } catch { /* Old malformed audit remains unavailable. */ }
  return row ? { id: row.id, agentId: row.agent_id, status: row.status, file: row.file, error: row.error,
    startedAtMs: row.started_at, finishedAtMs: row.finished_at, phase: row.phase ?? null,
    recoveryFile: row.recovery_file ?? null, preflight } : null;
}

/** Startup records only interrupted active rows; historical/unresolved rows are untouched. */
export async function recoverInterruptedRestores(): Promise<number> {
  return markInterruptedRestores();
}

/** Operator-only cleanup: label ownership, never shared volume mounts, selects helpers. */
export async function resolveAgentRestore(agentId: string, restoreId: number): Promise<void> {
  if (!isValidAgentId(agentId)) throw new RestoreRefusedError('Invalid agent id');
  const row = latestRestore(agentId);
  if (!row || row.id !== restoreId || row.status !== 'unresolved' || running.has(agentId)) {
    throw new RestoreRefusedError('This restore is no longer unresolved or another restore action is running; refresh and retry');
  }
  running.add(agentId);
  try {
    const agent = await inspectAgentContainer(agentId);
    const filters = encodeURIComponent(JSON.stringify({ label: [`rev4a.restore.agent=${agentId}`, `rev4a.restore.id=${row.id}`] }));
    const labelled = async () => {
      const helpers = await dockerRequestJson<{ Id: string }[]>('GET', `/containers/json?all=true&filters=${filters}`, 10_000);
      if (!Array.isArray(helpers) || helpers.some(helper => !helper.Id)) throw new Error('Unreadable restore helper identities');
      return helpers;
    };
    const helpers = await labelled();
    for (const helper of helpers) {
      if (helper.Id === agent?.Id || !(await removeRestoreHelper(helper.Id, agentId, row.id))) {
        throw new Error('Restore helper removal could not be confirmed');
      }
    }
    // Confirm again by label, including the no-helper case. No agent start/stop is attempted.
    if ((await labelled()).length) throw new Error('Restore helpers are still present');
    await deleteRestoreSource(row.source_directory);
    const note = `Manual resolution: ${helpers.length} labelled helper(s) removed and confirmed gone; reservation released. Agent container untouched; review the current volume before starting it or restoring the recovery backup`;
    updateRestoreRow(row.id, { status: 'interrupted', phase: 'manually_resolved', error: `${row.error ?? 'Restore needs review'}; ${note}` });
    console.warn(`[restore] Restore ${row.id} for ${agentId}: ${note}`);
  } catch {
    const note = 'Manual resolution failed: Docker may be unreachable or labelled helper cleanup could not be confirmed; reservation and pinned source retained. Retry Resolve restore when Docker is available';
    updateRestoreRow(row.id, { error: `${row.error?.split('; Manual resolution failed:')[0] ?? 'Restore needs review'}; ${note}` });
    throw new RestoreRefusedError(note);
  } finally { running.delete(agentId); }
}
