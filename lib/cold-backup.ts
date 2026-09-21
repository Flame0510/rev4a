/**
 * Cold backup of an agent's volume.
 *
 * The agent is stopped, a detached helper container archives the volume, the archive
 * is read back, and the agent is started again if it was running. A backup taken while
 * OpenClaw runs can copy its SQLite files mid-write; this one cannot.
 *
 * The helper container is the job: `rev4a-backup-<agentId>`, labelled with the agent,
 * the archive name, the kind and whether the agent was running. Everything needed to
 * finish or clean up a job lives in Docker, not in Rev4a's memory, so a job survives a
 * Rev4a restart: `reconcileColdBackups()` picks helpers up again at startup, and
 * finishing is idempotent.
 *
 * The archive is written as `<file>.partial` and renamed only after `tar -tzf` has read
 * all of it back and found `.openclaw/openclaw.json`, so a listed backup is complete.
 * Design: plans/COLD-BACKUP-PLAN.md.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dockerFetch } from '@/lib/docker-socket';
import { isValidAgentId } from '@/lib/container';
import { runDocker } from '@/lib/agent-images';

const execFileAsync = promisify(execFile);

export const BACKUP_VOLUME = 'rev4a-backups';
const HELPER_PREFIX = 'rev4a-backup-';
const LABEL_AGENT = 'rev4a.backup.agent';
const LABEL_FILE = 'rev4a.backup.file';
const LABEL_KIND = 'rev4a.backup.kind';
const LABEL_PREV = 'rev4a.backup.prev-state';
const LABEL_STARTED = 'rev4a.backup.started-at';
/** GNU tar counts checkpoints in records of 10 240 bytes of the uncompressed stream. */
const TAR_RECORD_BYTES = 10_240;
const CHECKPOINT_RECORDS = 2_000;
const WATCH_MS = 3_000;

export type ColdBackupKind = 'manual' | 'preupdate' | 'prerecreate';

export interface ColdBackupState {
  agentId: string;
  status: 'running' | 'succeeded' | 'failed';
  file: string;
  kind: ColdBackupKind;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  /** Uncompressed bytes to archive, from `du`; null until measured. */
  totalBytes: number | null;
  /** Uncompressed bytes archived so far. */
  doneBytes: number | null;
  percent: number | null;
  /** Archive size once complete. */
  archiveBytes: number | null;
  error: string | null;
}

export class ColdBackupBusyError extends Error {}

const helperName = (agentId: string) => `${HELPER_PREFIX}${agentId}`;

/**
 * The helper script, run by `sh` inside the agent's own image, which carries GNU tar,
 * coreutils and gzip. `FILE` comes in through the environment, never through the
 * script text. Machine-readable lines start with `REV4A `.
 */
const SCRIPT = [
  'set -u',
  'P="/backup/$FILE.partial"',
  'rm -f "$P"',
  'TOTAL=$(du -sb --exclude=.npm/_cacache /source 2>/dev/null | cut -f1)',
  'echo "REV4A total ${TOTAL:-0}"',
  'AVAIL=$(( $(df -Pk /backup | awk \'NR==2 {print $4}\') * 1024 ))',
  'NEED=$(( ${TOTAL:-0} * 6 / 10 ))',
  'if [ "$AVAIL" -lt "$NEED" ]; then echo "REV4A error not enough space in rev4a-backups: about $NEED bytes needed, $AVAIL free"; exit 3; fi',
  `if ! tar -czf "$P" --exclude=.npm/_cacache --checkpoint=${CHECKPOINT_RECORDS} --checkpoint-action=echo='REV4A progress %u' -C /source . ; then rm -f "$P"; echo "REV4A error tar failed"; exit 4; fi`,
  'if ! tar -tzf "$P" > /tmp/rev4a-list || ! grep -qx "./.openclaw/openclaw.json" /tmp/rev4a-list; then rm -f "$P"; echo "REV4A error verification failed: the archive does not read back or holds no .openclaw/openclaw.json"; exit 5; fi',
  'mv "$P" "/backup/$FILE" && chmod 644 "/backup/$FILE"',
  'echo "REV4A done $(stat -c %s "/backup/$FILE")"',
].join('\n');

interface HelperInspect {
  Id?: string;
  State?: { Running?: boolean; ExitCode?: number; StartedAt?: string; FinishedAt?: string };
  Config?: { Labels?: Record<string, string> };
}

async function inspectHelper(agentId: string): Promise<HelperInspect | null> {
  try {
    const info = await dockerFetch<HelperInspect>('GET', `/containers/${helperName(agentId)}/json`);
    return typeof info?.Id === 'string' ? info : null;
  } catch {
    return null;
  }
}

/** Whether a cold backup of this agent is running (its helper exists). */
export async function isColdBackupRunning(agentId: string): Promise<boolean> {
  const helper = await inspectHelper(agentId);
  return !!helper?.State?.Running;
}

async function helperLog(agentId: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', ['logs', '--tail', '400', helperName(agentId)], {
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch {
    return '';
  }
}

function parseLog(log: string) {
  let totalBytes: number | null = null;
  let doneBytes: number | null = null;
  let archiveBytes: number | null = null;
  let error: string | null = null;
  for (const raw of log.split('\n')) {
    const at = raw.indexOf('REV4A ');
    if (at === -1) continue;
    const [kind, ...rest] = raw.slice(at + 6).trim().split(' ');
    const value = rest.join(' ');
    if (kind === 'total') totalBytes = Number(value) || null;
    else if (kind === 'progress') doneBytes = (Number(value) || 0) * TAR_RECORD_BYTES;
    else if (kind === 'done') archiveBytes = Number(value) || null;
    else if (kind === 'error') error = value;
  }
  const percent = totalBytes && doneBytes !== null ? Math.min(99, Math.round((doneBytes / totalBytes) * 100)) : null;
  return { totalBytes, doneBytes, archiveBytes, error, percent };
}

function stateFrom(agentId: string, helper: HelperInspect, log: string, status: ColdBackupState['status']): ColdBackupState {
  const labels = helper.Config?.Labels ?? {};
  const parsed = parseLog(log);
  const finished = helper.State?.FinishedAt && !helper.State.FinishedAt.startsWith('0001') ? Date.parse(helper.State.FinishedAt) : null;
  return {
    agentId,
    status,
    file: labels[LABEL_FILE] ?? '',
    kind: labels[LABEL_KIND] === 'preupdate' ? 'preupdate' : labels[LABEL_KIND] === 'prerecreate' ? 'prerecreate' : 'manual',
    startedAtMs: Number(labels[LABEL_STARTED]) || null,
    finishedAtMs: status === 'running' ? null : finished,
    totalBytes: parsed.totalBytes,
    doneBytes: parsed.doneBytes,
    percent: status === 'succeeded' ? 100 : parsed.percent,
    archiveBytes: parsed.archiveBytes,
    error: status === 'failed' ? parsed.error ?? `backup helper exited with code ${helper.State?.ExitCode ?? '?'}` : null,
  };
}

/** Results of jobs finished since this process started, for status reads after the helper is gone. */
const finished = new Map<string, ColdBackupState>();
/** Finishing in flight, so concurrent status reads finish a job once. */
const finishing = new Map<string, Promise<ColdBackupState>>();
const watching = new Set<string>();

async function startAgentIfItWasRunning(labels: Record<string, string>, agentId: string): Promise<void> {
  if (labels[LABEL_PREV] !== 'running') return;
  const container = await agentContainerName(agentId);
  if (container) await runDocker(['start', container], { timeoutMs: 60_000 }).catch(() => {});
}

async function removePartial(file: string): Promise<void> {
  if (!file) return;
  await runDocker(
    ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, '-e', `FILE=${file}`, 'alpine', 'sh', '-c', 'rm -f "/backup/$FILE.partial"'],
    { timeoutMs: 60_000 },
  ).catch(() => {});
}

/** Finish an exited job: record its result, start the agent if it was running, remove the helper. */
async function finishJob(agentId: string, helper: HelperInspect): Promise<ColdBackupState> {
  const inFlight = finishing.get(agentId);
  if (inFlight) return inFlight;
  const job = (async () => {
    const log = await helperLog(agentId);
    const ok = helper.State?.ExitCode === 0 && /REV4A done \d+/.test(log);
    const state = stateFrom(agentId, helper, log, ok ? 'succeeded' : 'failed');
    const labels = helper.Config?.Labels ?? {};
    if (!ok) await removePartial(state.file);
    await startAgentIfItWasRunning(labels, agentId);
    await runDocker(['rm', '-f', helperName(agentId)], { timeoutMs: 30_000 }).catch(() => {});
    finished.set(agentId, state);
    return state;
  })();
  finishing.set(agentId, job);
  try {
    return await job;
  } finally {
    finishing.delete(agentId);
  }
}

/** Current or last cold backup of an agent; finishes the job when its helper has exited. */
export async function coldBackupStatus(agentId: string): Promise<ColdBackupState | null> {
  const helper = await inspectHelper(agentId);
  if (!helper) return finishing.get(agentId) ?? finished.get(agentId) ?? null;
  if (helper.State?.Running) return stateFrom(agentId, helper, await helperLog(agentId), 'running');
  return finishJob(agentId, helper);
}

/** Polls a running job until it finishes, so the agent restarts even when nobody reads its status. */
function watch(agentId: string): void {
  if (watching.has(agentId)) return;
  watching.add(agentId);
  const tick = async () => {
    const state = await coldBackupStatus(agentId).catch(() => null);
    if (state?.status === 'running') {
      setTimeout(() => { void tick(); }, WATCH_MS);
    } else {
      watching.delete(agentId);
    }
  };
  setTimeout(() => { void tick(); }, WATCH_MS);
}

interface ContainerInspect {
  Name?: string;
  Image?: string;
  State?: { Running?: boolean };
}

async function agentContainerName(agentId: string): Promise<string | null> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`AGENT_ID=${agentId}`] }));
  const list = await dockerFetch<{ Names?: string[] }[]>('GET', `/containers/json?all=true&filters=${filters}`).catch(() => null);
  const name = Array.isArray(list) ? list[0]?.Names?.[0] : undefined;
  return name ? name.replace(/^\//, '') : null;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Start a cold backup. Returns once the helper runs; the archive is written in the
 * background. `label` goes into the file name (the OpenClaw version, for a pre-update
 * backup): `agent-<id>-preupdate-<label>-<ts>.tar.gz` or `agent-<id>-cold-<ts>.tar.gz`.
 * Throws `ColdBackupBusyError` when a backup of this agent is already running.
 */
export async function startColdBackup(
  agentId: string,
  /** `leaveStopped`: do not start the agent afterwards — the Update action recreates it next. */
  opts: { kind: ColdBackupKind; label?: string; leaveStopped?: boolean },
): Promise<{ file: string }> {
  if (!isValidAgentId(agentId)) throw new Error('Invalid agent id');
  if (await inspectHelper(agentId)) {
    const current = await coldBackupStatus(agentId);
    if (current?.status === 'running') throw new ColdBackupBusyError('A backup of this agent is already running');
  }

  const name = await agentContainerName(agentId);
  if (!name) throw new Error(`No container found with AGENT_ID '${agentId}'`);
  const container = await dockerFetch<ContainerInspect>('GET', `/containers/${encodeURIComponent(name)}/json`);
  if (!container?.Image) throw new Error(`Container '${name}' could not be inspected`);
  const volume = `agent-${agentId}-data`;
  const vol = await dockerFetch<{ Name?: string }>('GET', `/volumes/${volume}`).catch(() => null);
  if (vol?.Name !== volume) throw new Error(`No persistent volume found for agent '${agentId}'`);

  const label = (opts.label ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  const file = opts.kind === 'preupdate'
    ? `agent-${agentId}-preupdate-${label || 'unknown'}-${timestamp()}.tar.gz`
    : opts.kind === 'prerecreate'
      ? `agent-${agentId}-prerecreate-${timestamp()}.tar.gz`
      : `agent-${agentId}-cold-${timestamp()}.tar.gz`;

  const wasRunning = container.State?.Running === true;
  if (wasRunning) {
    await runDocker(['stop', '-t', '30', name], { timeoutMs: 45_000 })
      .catch(() => runDocker(['kill', name], { timeoutMs: 15_000 }));
  }

  try {
    await runDocker([
      'run', '-d', '--name', helperName(agentId),
      '--label', `${LABEL_AGENT}=${agentId}`,
      '--label', `${LABEL_FILE}=${file}`,
      '--label', `${LABEL_KIND}=${opts.kind}`,
      '--label', `${LABEL_PREV}=${wasRunning && !opts.leaveStopped ? 'running' : 'stopped'}`,
      '--label', `${LABEL_STARTED}=${Date.now()}`,
      '-e', `FILE=${file}`,
      '-v', `${volume}:/source:ro`,
      '-v', `${BACKUP_VOLUME}:/backup`,
      '--entrypoint', 'sh',
      container.Image,
      '-c', SCRIPT,
    ], { timeoutMs: 60_000 });
  } catch (e) {
    await runDocker(['rm', '-f', helperName(agentId)], { timeoutMs: 30_000 }).catch(() => {});
    if (wasRunning) await runDocker(['start', name], { timeoutMs: 60_000 }).catch(() => {});
    throw new Error(`Could not start the backup: ${(e as Error).message}`);
  }

  finished.delete(agentId);
  watch(agentId);
  return { file };
}

/** Cancel a running backup: the partial archive is removed and the agent restarted if it was running. */
export async function cancelColdBackup(agentId: string): Promise<boolean> {
  const helper = await inspectHelper(agentId);
  if (!helper?.State?.Running) return false;
  const labels = helper.Config?.Labels ?? {};
  await runDocker(['rm', '-f', helperName(agentId)], { timeoutMs: 30_000 }).catch(() => {});
  await removePartial(labels[LABEL_FILE] ?? '');
  await startAgentIfItWasRunning(labels, agentId);
  finished.set(agentId, { ...stateFrom(agentId, helper, '', 'failed'), error: 'cancelled', finishedAtMs: Date.now() });
  return true;
}

/** Wait for a job to finish, reporting progress. Resolves with the final state. */
export async function waitForColdBackup(
  agentId: string,
  opts: { onProgress?: (state: ColdBackupState) => void; pollMs?: number; timeoutMs?: number } = {},
): Promise<ColdBackupState> {
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : null;
  for (;;) {
    const state = await coldBackupStatus(agentId);
    if (!state) throw new Error('The backup job disappeared');
    if (state.status !== 'running') return state;
    opts.onProgress?.(state);
    if (deadline && Date.now() >= deadline) {
      // The helper is stuck: say so instead of hanging the caller (and the agent's
      // busy lock) forever. The job is left alone — an operator can cancel it.
      throw new Error(`The cold backup did not finish within ${Math.round(opts.timeoutMs! / 60_000)} minutes`);
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 2_000));
  }
}

/** Agent ids with a backup helper, running or exited. */
export async function listColdBackupHelpers(): Promise<string[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [LABEL_AGENT] }));
  const list = await dockerFetch<{ Labels?: Record<string, string> }[]>('GET', `/containers/json?all=true&filters=${filters}`).catch(() => null);
  return (Array.isArray(list) ? list : []).map((c) => c.Labels?.[LABEL_AGENT] ?? '').filter(Boolean);
}

/** Agent ids with a cold backup currently running (helper container still running). */
export async function listRunningColdBackups(): Promise<string[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [LABEL_AGENT], status: ['running'] }));
  const list = await dockerFetch<{ Labels?: Record<string, string> }[]>('GET', `/containers/json?all=true&filters=${filters}`).catch(() => null);
  return (Array.isArray(list) ? list : []).map((c) => c.Labels?.[LABEL_AGENT] ?? '').filter(Boolean);
}

/** At startup: finish helpers that exited while Rev4a was down, and watch the ones still running. */
export async function reconcileColdBackups(): Promise<void> {
  for (const agentId of await listColdBackupHelpers()) {
    const state = await coldBackupStatus(agentId).catch(() => null);
    if (state?.status === 'running') watch(agentId);
  }
}
