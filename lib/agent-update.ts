/**
 * The Update action: move one agent to a newer supported OpenClaw version.
 *
 * Each step is recorded in `agent_upgrades` before it starts:
 *
 *   pending     preflight: agent running, target downloaded, newer and supported,
 *               no backup or update already running; wait for the Gateway to finish starting
 *   (baseline)  transcript events per session and cron job identities/ownership, read inside the agent
 *   backing_up  cold backup `agent-<id>-preupdate-<from>-<ts>.tar.gz`; the agent stays stopped
 *   migrating   container recreated on `openclaw-agent-base:<to>`; its entrypoint runs
 *               `doctor --fix`; Rev4a waits for `/startupz` to report the target version,
 *               then re-applies its own config
 *   verifying   every session has at least as many events as before, every cron job is
 *               still there
 *   done | failed
 *
 * A version change migrates data one way: the previous version refuses the migrated
 * database, so going back means restoring the pre-update backup on the previous image
 * (Rollback). The job runs inside the Rev4a process; after a Rev4a restart an unfinished
 * one is marked `interrupted` (lib/agent-update-state.ts).
 */
import { dockerExec, dockerExecNoFail } from '@/lib/docker-exec';
import { isValidAgentId } from '@/lib/container';
import { gatewayCliArgv } from '@/lib/gateway-cli';
import { compareVersions, isSupportedVersion, localImageRef, parseOpenClawVersion } from '@/lib/agent-versions';
import {
  containerOpenClawVersion,
  listLocalAgentImages,
  localVersionExists,
  newestLocalSupportedVersion,
  pruneAgentImages,
  pullAgentImage,
  runDocker,
} from '@/lib/agent-images';
import { backupMountSource, locateBackup } from '@/lib/backups-volume';
import { coldBackupStatus, isColdBackupRunning, startColdBackup, waitForColdBackup } from '@/lib/cold-backup';
import { inspectAgentContainer, recreateAgentContainer, startAndVerifyContainer, type AgentContainerInspect } from '@/lib/agent-recreate';
import { applyRuntimeConfig } from '@/lib/agent-setup';
import { probeGateway, waitForGatewayReady } from '@/lib/agent-readiness';
import { patchRev4aProvider } from '@/app/api/gateway/sync';
import { ACTIVE_STATUSES as ACTIVE_STATUSES_FOR_VIEW, activeUpdateAgentIds, claimRollbackUpdate, insertUpdate, latestUpdate, markInterruptedUpdates, markUpdateResolved, recordCronRepairAudit, unresolvedFailedUpdates, updateHistory, updateRow, type AgentUpdateRow } from '@/lib/agent-update-state';
import { baselineWithCronEvidence, cronNames, isCronRepairCandidate, parseCronListForUpdate, readCronRepairAudit, readUpdateBaseline, verifyUpdateBaseline, type CronJobIdentity, type CronRepairAudit, type CronTransition, type PreUpdateCronEvidenceReader, type UpdateBaseline, type UpdateVerification } from '@/lib/agent-update-cron';
import { agentBusyReason } from '@/lib/agent-busy';
import { latestRecreate } from '@/lib/agent-recreate-state';
import { latestRestore } from '@/lib/agent-restore-state';
import { laterJob, type LaterJob } from '@/lib/agent-update-later-job';
import { reapplyWhenReady } from '@/lib/credentials/delivery';
import { DEFAULT_FINISH_TIMINGS, dueForRecheck, evaluateResolution, finishAfterRecreate, resolutionText, offersRollback, offersRollbackAnyway, verifyJsonForStore, whenEligible, type ContainerState } from '@/lib/agent-update-resolution';
import { adoptCronInferenceAccount, type CronAccountAdoption } from '@/lib/agent-update-cron-account';
import { readPreUpdateCronEvidence } from '@/lib/backup-cron-evidence';
import { redactSecret } from '@/lib/redact-secret';
import { AGENTS_TOKEN_FILE } from '@/lib/rev4a-paths';
import fs from 'node:fs';
import { acquireAgentResourcePreflight } from '@/lib/agent-resource-preflight';

/** A migration runs `doctor --fix` before the Gateway starts; allow for large state. */
const MIGRATION_READY_TIMEOUT_MS = 10 * 60 * 1000;
/** A cold backup of a 13 GB volume takes ~8 minutes; anything past this is stuck. */
const COLD_BACKUP_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export class UpdateRefusedError extends Error {}

/**
 * Counts transcript events per session, inside the agent: `transcript_events` rows in
 * `openclaw-agent.sqlite`. Keys are `<agent>/<session id>`; trajectory files are debug
 * traces and are not counted.
 *
 * Two other places are read as well, each taking the maximum per session (never the sum):
 *  - `sessions/*.jsonl`, for a build that still writes transcripts as files;
 *  - `session-sqlite-import-archive/archive-tier.<id>.jsonl.imported-<ts>`, where 9.x
 *    moves the old `.jsonl` files after importing them into SQLite. A session whose
 *    events were **not** imported lives only there, so without it the count drops to
 *    zero and a healthy migration reads as lost data (seen on the VPS with 10 short
 *    sessions of an agent: the archived file still held the same 8 lines).
 */
const COUNT_TRANSCRIPTS = `
const fs = require('fs'), path = require('path');
const out = {};
const bump = (key, n) => { if (n > (out[key] || 0)) out[key] = n; };
const linesOf = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\\n').filter((l) => l.trim()).length; } catch { return 0; }
};
const root = '/root/.openclaw/agents';
for (const agent of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  const base = path.join(root, agent);
  const sessions = path.join(base, 'sessions');
  if (fs.existsSync(sessions)) {
    for (const f of fs.readdirSync(sessions)) {
      if (!f.endsWith('.jsonl') || f.endsWith('.trajectory.jsonl')) continue;
      bump(agent + '/' + f.slice(0, -'.jsonl'.length), linesOf(path.join(sessions, f)));
    }
  }
  const archive = path.join(base, 'session-sqlite-import-archive');
  if (fs.existsSync(archive)) {
    for (const f of fs.readdirSync(archive)) {
      if (f.includes('.trajectory.jsonl')) continue;
      const m = f.match(/^archive-tier\\.(.+?)\\.jsonl\\.imported-\\d+$/);
      if (m) bump(agent + '/' + m[1], linesOf(path.join(archive, f)));
    }
  }
  const dbFile = path.join(base, 'agent', 'openclaw-agent.sqlite');
  if (fs.existsSync(dbFile)) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const hasEvents = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events'").get();
    if (hasEvents) {
      for (const r of db.prepare('SELECT session_id, COUNT(*) AS n FROM transcript_events GROUP BY session_id').all()) {
        bump(agent + '/' + r.session_id, Number(r.n));
      }
    }
    db.close();
  }
}
process.stdout.write('REV4A-COUNTS ' + JSON.stringify(out) + '\\n');
`;

async function countTranscripts(container: string): Promise<Record<string, number>> {
  const out = await dockerExec(container, ['node', '-e', COUNT_TRANSCRIPTS], { timeoutMs: 120_000 });
  const line = out.split('\n').find((l) => l.startsWith('REV4A-COUNTS '));
  if (!line) throw new Error('Could not count the transcript events');
  return JSON.parse(line.slice('REV4A-COUNTS '.length)) as Record<string, number>;
}

/** Stable identities and native ownership; null is unreadable, never a valid empty list. */
async function cronJobIdentities(container: string): Promise<CronJobIdentity[] | null> {
  const out = await dockerExecNoFail(container, gatewayCliArgv(['cron', 'list', '--all', '--json']), { timeoutMs: 120_000 });
  return parseCronListForUpdate(out);
}

/** The agent container as Docker reports it; null when it is gone, a thrown error when it cannot be inspected. */
async function containerState(agentId: string): Promise<ContainerState | null> {
  const container = await inspectAgentContainer(agentId);
  if (!container) return null;
  const state = container.State;
  return { running: state?.Running === true, status: state?.Status ?? (state?.Running ? 'running' : 'exited'), restartCount: Number((container as { RestartCount?: number }).RestartCount ?? 0) || 0 };
}

async function runningVersion(container: string): Promise<string | null> {
  const body = await dockerExecNoFail(container, ['curl', '-s', '--max-time', '3', 'http://127.0.0.1:3000/startupz'], { timeoutMs: 10_000 });
  try {
    return parseOpenClawVersion(String((JSON.parse(body) as { version?: unknown }).version ?? ''));
  } catch {
    return null;
  }
}

type Baseline = UpdateBaseline;
export type Verification = UpdateVerification;

export function verify(baseline: Baseline, transcripts: Record<string, number>, cronJobs: CronJobIdentity[] | string[] | null, transition?: CronTransition): Verification {
  return verifyUpdateBaseline(baseline, transcripts, cronJobs, transition);
}

export interface NowVerification {
  verification: Verification;
  /** Why the update cannot be called verified (lost events, missing or unreadable cron jobs); null when it can. */
  error: string | null;
  /** The baseline had cron jobs but the list could not be read. */
  cronUnreadable: boolean;
}

/** Compare the agent, as it is now, with a stored baseline. Shared by the update and the after-the-fact check. */
async function verifyNow(container: string, baseline: Baseline, transition?: CronTransition): Promise<NowVerification> {
  const transcriptsAfter = await countTranscripts(container);
  const cronAfter = await cronJobIdentities(container);
  // Unreadable is not "no jobs": refuse to call the update verified rather than
  // report `done` while cron loss would be undetectable.
  const verification = verify(baseline, transcriptsAfter, cronAfter, transition);
  const cronUnreadable = verification.missingCronJobs === null;
  let error: string | null = null;
  if (cronUnreadable) error = 'The cron job list could not be read after the update, so the verification is incomplete';
  else if (!verification.ok) {
    error = verification.lostEvents.length
      ? `${verification.lostEvents.length} session(s) have fewer transcript events than before the update`
      : `Cron jobs missing after the update: ${(verification.missingCronJobs ?? []).join(', ')}`;
  }
  return { verification, error, cronUnreadable };
}

/** Jobs running in this process, so a second start for the same agent is refused. */
const running = new Set<string>();

/**
 * Start an update. Validates synchronously enough to refuse clearly (UpdateRefusedError),
 * then runs the steps in the background. Returns the new row id.
 */
export async function startAgentUpdate(agentId: string, requestedVersion?: string): Promise<number> {
  if (!isValidAgentId(agentId)) throw new UpdateRefusedError('Invalid agent id');
  if (running.has(agentId)) throw new UpdateRefusedError('An update of this agent is already running');
  // Claimed synchronously, before the first await, so two requests cannot both pass.
  running.add(agentId);
  try {
    // One source for every long operation: an update, recreate, restore, edit or backup.
    const busy = await agentBusyReason(agentId);
    if (busy) throw new UpdateRefusedError(busy);

    return await runUpdateStart(agentId, requestedVersion);
  } catch (e) {
    running.delete(agentId);
    if (e && typeof e === 'object' && (e as { code?: unknown }).code === 'REV4A_AGENT_JOB_BUSY') {
      throw new UpdateRefusedError((e as Error).message);
    }
    throw e;
  }
}

async function runUpdateStart(agentId: string, requestedVersion?: string): Promise<number> {
  const container = await inspectAgentContainer(agentId);
  if (!container) throw new UpdateRefusedError(`No container found with AGENT_ID '${agentId}'`);
  if (!container.State?.Running) throw new UpdateRefusedError('Start the agent before updating it: its data is counted while it runs');
  const name = (container.Name ?? '').replace(/^\//, '');

  const images = await listLocalAgentImages();
  const fromVersion = await containerOpenClawVersion({ id: container.Id, name, imageId: container.Image ?? '', running: true }, images);
  if (!fromVersion) throw new UpdateRefusedError('The OpenClaw version this agent runs could not be read');

  const toVersion = requestedVersion ?? newestLocalSupportedVersion(images);
  if (!toVersion || !isSupportedVersion(toVersion)) throw new UpdateRefusedError('No supported OpenClaw version to update to is downloaded');
  // The compatibility lookup throws on unknown; only confirmed existence may start an update.
  if ((await localVersionExists(toVersion)) !== true) throw new UpdateRefusedError(`OpenClaw ${toVersion} is not downloaded`);
  if (compareVersions(toVersion, fromVersion) <= 0) {
    throw new UpdateRefusedError(`The agent already runs OpenClaw ${fromVersion}; ${toVersion} is not newer`);
  }

  const memory = container.HostConfig?.Memory;
  if (typeof memory !== 'number' || !Number.isFinite(memory) || memory < 0) throw new UpdateRefusedError('The current memory limit could not be read; nothing was changed');
  let releaseResources: () => void;
  try {
    releaseResources = await acquireAgentResourcePreflight({
      version: toVersion, operation: 'update', targetAgentId: agentId, limitMb: memory === 0 ? null : memory / (1024 * 1024),
    });
  } catch (e) { throw new UpdateRefusedError((e as Error).message); }
  try {
    const id = insertUpdate(agentId, fromVersion, toVersion, name);
    void runUpdate(id, agentId, name, fromVersion, toVersion).finally(() => {
      releaseResources();
      running.delete(agentId);
      if (process.env.REV4A_DOMAIN?.trim()) {
        void import('@/lib/domain-sync').then(({ syncDomainRoutes }) => syncDomainRoutes())
          .catch(() => console.warn('[domain] Could not load Caddy sync.'));
      }
    });
    return id;
  } catch (e) { releaseResources(); throw e; }
}

async function runUpdate(id: number, agentId: string, name: string, fromVersion: string, toVersion: string): Promise<void> {
  let stopped = false;
  try {
    // Docker can report running long before the Gateway accepts CLI calls. Keep the
    // row pending and leave the agent untouched until startup has finished.
    const ready = await waitForGatewayReady(name, 300_000);
    if (!ready || !(await inspectAgentContainer(agentId))?.State?.Running) {
      throw new Error("The agent's Gateway did not finish starting within 5 minutes; nothing was stopped or backed up. Wait until the agent is ready and try again.");
    }
    let jobs = await cronJobIdentities(name);
    if (jobs === null) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      jobs = await cronJobIdentities(name);
    }
    if (jobs === null) throw new Error('The cron job list could not be read before the update; nothing was stopped or backed up');
    const baseline: Baseline = {
      transcripts: await countTranscripts(name), cronJobs: cronNames(jobs), cronBaselineVersion: 1, cronJobIdentities: jobs,
    };
    updateRow(id, { baseline_json: JSON.stringify(baseline), status: 'backing_up' });

    const { file } = await startColdBackup(agentId, { kind: 'preupdate', label: fromVersion, leaveStopped: true });
    stopped = true;
    updateRow(id, { backup_file: file });
    const backup = await waitForColdBackup(agentId, { timeoutMs: COLD_BACKUP_WAIT_TIMEOUT_MS });
    if (backup.status !== 'succeeded') throw new Error(`The pre-update backup failed: ${backup.error ?? 'unknown error'}`);

    updateRow(id, { status: 'migrating' });
    const container = await inspectAgentContainer(agentId);
    if (!container) throw new Error('The agent container disappeared during the update');
    await recreateAgentContainer(agentId, container, localImageRef(toVersion));
    stopped = false;

    // A slow start (a large migration) is not a failure: after the first window Rev4a keeps
    // waiting in the background, then runs exactly the steps that were left.
    await finishAfterRecreate(
      {
        waitReady: (timeoutMs) => waitForGatewayReady(agentId, timeoutMs),
        runningVersion: () => runningVersion(agentId),
        containerState: () => containerState(agentId),
        onSlowStart: () => updateRow(id, {
          error: `OpenClaw ${toVersion} is still starting after ${MIGRATION_READY_TIMEOUT_MS / 60_000} minutes; Rev4a keeps waiting`,
        }),
        applyConfig: async () => {
          await applyRuntimeConfig(agentId);
          try {
            await patchRev4aProvider(agentId);
          } catch (e) {
            console.error('[agent:update] provider patch failed:', redactSecret((e as Error).message, readAgentsToken()));
          }
        },
        // The slow-start note ("still starting") is stale once the Gateway answers.
        onVerifying: () => updateRow(id, { status: 'verifying', error: null }),
        verify: async () => {
          const result = await verifyNow(agentId, baseline, { fromVersion, toVersion });
          const stored = verifyJsonForStore(result.verification, result.cronUnreadable);
          if (stored !== null) updateRow(id, { verify_json: stored });
          if (result.error) throw new Error(result.error);
        },
      },
      toVersion,
      { ...DEFAULT_FINISH_TIMINGS, firstWindowMs: MIGRATION_READY_TIMEOUT_MS },
    );

    let cronAccount: CronAccountAdoption | null = null;
    try { cronAccount = await adoptCronInferenceAccount(name, fromVersion, toVersion, id); }
    catch { cronAccount = { associated: 0, noBindingNeeded: 0, alreadyAssociated: 0, skipped: 0, failed: 1,
      note: 'Cron inference account adoption could not be completed. Select the intended account for affected jobs in OpenClaw.' }; }
    updateRow(id, { status: 'done', error: null, cron_account_json: cronAccount ? JSON.stringify(cronAccount) : null });

    // Retention: images nothing needs any more (lib/agent-images.ts). Best-effort.
    pruneAgentImages()
      .then((removed) => { if (removed.length) console.log(`[agent:update] removed unused agent images: ${removed.join(', ')}`); })
      .catch((err: unknown) => console.warn('[agent:update] image cleanup failed:', (err as Error).message));
  } catch (e) {
    // A failure before the recreate leaves the old container stopped by the backup:
    // start it again, so a failed update never leaves the agent down. When it does not
    // come back the failure text says so — a container that is "running" with no network
    // is not an agent the operator can use.
    if (stopped) {
      const container = await inspectAgentContainer(agentId).catch(() => null);
      const containerName = container?.Name?.replace(/^\//, '');
      if (containerName && !container?.State?.Running) {
        const started = await startAndVerifyContainer(agentId, containerName);
        if (!started.ok) {
          const note = `the previous container did not come back: ${started.error}`;
          const message = shortError(e);
          updateRow(id, { status: 'failed', error: `${message}; ${note}` });
          return;
        }
      }
    }
    updateRow(id, { status: 'failed', error: shortError(e) });
  }
}

/** The agents' shared Gateway token, to keep it out of stored error texts; empty when unreadable. */
function readAgentsToken(): string {
  try {
    const data = JSON.parse(fs.readFileSync(AGENTS_TOKEN_FILE, 'utf-8')) as { token?: unknown };
    return typeof data.token === 'string' ? data.token.trim() : '';
  } catch {
    return '';
  }
}

/** The useful part of an error for the panel: a `docker exec` failure carries a whole stack trace. */
function shortError(e: unknown): string {
  const message = redactSecret((e as Error)?.message ?? String(e), readAgentsToken());
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const cause = lines.find((l) => /^(Error|[A-Z]\w*Error):/.test(l));
  const text = cause && cause !== lines[0] ? `${lines[0]} ${cause}` : lines[0] ?? message;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * At startup no update can still be running: rows still active were cut off by the
 * restart. They become `interrupted` and an agent the pre-update backup left stopped is
 * started again, so a Rev4a restart during the backup window never leaves it down. The
 * row stays `interrupted`, so the operator can still roll back.
 */
export async function recoverInterruptedUpdates(): Promise<number> {
  const ids = activeUpdateAgentIds();
  // Always clear stale repair reservations, even without an interrupted update.
  // A repair never owns container power state and must not add restart candidates.
  const interrupted = markInterruptedUpdates();
  for (const agentId of ids) {
    const container = await inspectAgentContainer(agentId).catch(() => null);
    const name = container?.Name?.replace(/^\//, '');
    if (!name || container?.State?.Running) continue;
    const started = await startAndVerifyContainer(agentId, name);
    if (!started.ok) console.warn(`[agent:update] ${agentId} did not come back after an interrupted update: ${started.error}`);
  }
  return interrupted;
}

/** The agent's current version and the version an Update would move it to, if any. */
export async function updateCandidate(agentId: string): Promise<{
  currentVersion: string | null;
  candidate: { fromVersion: string; toVersion: string } | null;
}> {
  const container = await inspectAgentContainer(agentId);
  if (!container) return { currentVersion: null, candidate: null };
  const images = await listLocalAgentImages();
  const currentVersion = await containerOpenClawVersion(
    { id: container.Id, name: (container.Name ?? '').replace(/^\//, ''), imageId: container.Image ?? '', running: container.State?.Running === true },
    images,
  );
  const newest = newestLocalSupportedVersion(images);
  const candidate = currentVersion && newest && compareVersions(newest, currentVersion) > 0
    ? { fromVersion: currentVersion, toVersion: newest }
    : null;
  return { currentVersion, candidate };
}

// ── Rollback ─────────────────────────────────────────────────────────────────

const RESTORE_TIMEOUT_MS = 60 * 60 * 1000;
const ROLLBACK_READY_TIMEOUT_MS = 5 * 60 * 1000;
const ROLLBACK_FROM: readonly AgentUpdateRow['status'][] = ['done', 'failed', 'interrupted', 'rollback_failed'];

/**
 * Whether the backup file exists: a plain file check in the backups folder, plus one helper container
 * for the legacy volume only while it exists. A Docker failure there throws instead of reading as "deleted".
 */
async function backupFileExists(file: string): Promise<boolean> {
  return (await locateBackup(file)) !== null;
}

const BACKUP_CHECK_TTL_MS = 60_000;
const backupChecks = ((globalThis as { __rev4aBackupChecks?: Map<string, { exists: boolean; at: number }> }).__rev4aBackupChecks ??= new Map());

/** Forget what is known about the pre-update backup files of an agent (after one is deleted). */
export function forgetBackupAvailability(agentId: string): void {
  for (const key of backupChecks.keys()) if (key.startsWith(`${agentId}\u0000`)) backupChecks.delete(key);
}

/** Whether the file exists, cached for 60 s per agent and file; null when the check itself fails. */
async function backupAvailability(agentId: string, file: string): Promise<boolean | null> {
  const key = `${agentId}\u0000${file}`;
  const hit = backupChecks.get(key);
  if (hit && Date.now() - hit.at < BACKUP_CHECK_TTL_MS) return hit.exists;
  try {
    const exists = await backupFileExists(file);
    backupChecks.set(key, { exists, at: Date.now() });
    return exists;
  } catch {
    return null;
  }
}

/**
 * Roll the latest update of an agent back: restore its pre-update backup on the version
 * it ran before. Everything the agent did after that backup is lost. Refused
 * (UpdateRefusedError) when there is nothing to roll back or the backup is gone.
 */
export async function startAgentRollback(agentId: string): Promise<number> {
  if (!isValidAgentId(agentId)) throw new UpdateRefusedError('Invalid agent id');
  if (running.has(agentId)) throw new UpdateRefusedError('An update of this agent is running');
  // Claimed synchronously, then the same single busy source as the update.
  running.add(agentId);
  try {
    const busy = await agentBusyReason(agentId);
    if (busy) throw new UpdateRefusedError(busy);
    return await runRollbackStart(agentId);
  } catch (e) {
    running.delete(agentId);
    if ((e as { code?: unknown })?.code === 'REV4A_AGENT_JOB_BUSY') throw new UpdateRefusedError((e as Error).message);
    throw e;
  }
}

async function runRollbackStart(agentId: string): Promise<number> {
  const row = latestUpdate(agentId);
  if (!row || !ROLLBACK_FROM.includes(row.status)) throw new UpdateRefusedError('There is no update of this agent to roll back');
  if (!row.backup_file || !row.from_version) throw new UpdateRefusedError('This update has no pre-update backup to restore');
  // Refused up front, not mid-way: a version this build no longer lists has no image it can recreate.
  if (!isSupportedVersion(row.from_version)) {
    throw new UpdateRefusedError(`This Rev4a no longer supports OpenClaw ${row.from_version} (the version this update moved away from), so it cannot roll back to it`);
  }
  let exists: boolean;
  try {
    exists = await backupFileExists(row.backup_file);
  } catch (e) {
    throw new UpdateRefusedError(`Could not check the pre-update backup: ${(e as Error).message}`);
  }
  if (!exists) throw new UpdateRefusedError(`The pre-update backup ${row.backup_file} no longer exists`);
  forgetBackupAvailability(agentId);
  const container = await inspectAgentContainer(agentId);
  if (!container) throw new UpdateRefusedError(`No container found with AGENT_ID '${agentId}'`);

  // A rollback clears any earlier resolution: if it is cut off, the row is red again with Roll back.
  claimRollbackUpdate(row);
  void runRollback(row, container).finally(() => {
    running.delete(agentId);
    if (process.env.REV4A_DOMAIN?.trim()) {
      void import('@/lib/domain-sync').then(({ syncDomainRoutes }) => syncDomainRoutes())
        .catch(() => console.warn('[domain] Could not load Caddy sync.'));
    }
  });
  return row.id;
}

/**
 * Restore exactly the pre-update state: the volume from the backup, the container on the
 * previous image. Rev4a's config patches are not re-applied — the restored `openclaw.json` is the
 * one that version accepted; only the agent's enabled credentials are, in the background.
 */
async function runRollback(row: AgentUpdateRow, container: AgentContainerInspect): Promise<void> {
  const agentId = row.agent_id;
  const fromVersion = row.from_version as string;
  const file = row.backup_file as string;
  try {
    // Unknown throws before stopping the agent or touching its image/volume; false means missing.
    if ((await localVersionExists(fromVersion)) === false) {
      if (!isSupportedVersion(fromVersion)) {
        throw new Error(`The image for OpenClaw ${fromVersion} is not available locally and this Rev4a cannot download it`);
      }
      await pullAgentImage(fromVersion);
    }

    const name = (container.Name ?? '').replace(/^\//, '');
    if (container.State?.Running) {
      await runDocker(['stop', '-t', '30', name], { timeoutMs: 45_000 })
        .catch(() => runDocker(['kill', name], { timeoutMs: 15_000 }));
    }

    // Where the archive is now: the backups folder, or the legacy volume until it is migrated.
    const backupSource = await backupMountSource(file);
    if (!backupSource) throw new Error(`The pre-update backup '${file}' no longer exists`);
    await runDocker(
      [
        'run', '--rm',
        '-v', `agent-${agentId}-data:/target`,
        '-v', `${backupSource}:/backup:ro`,
        'alpine', 'sh', '-c',
        'test -f "/backup/$FILE" || exit 3; rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null; tar xzf "/backup/$FILE" -C /target',
      ],
      { timeoutMs: RESTORE_TIMEOUT_MS, env: { FILE: file } },
    );

    await recreateAgentContainer(agentId, container, localImageRef(fromVersion));
    if (!(await waitForGatewayReady(agentId, ROLLBACK_READY_TIMEOUT_MS))) {
      throw new Error(`OpenClaw ${fromVersion} did not finish starting within ${ROLLBACK_READY_TIMEOUT_MS / 60_000} minutes`);
    }
    const version = parseOpenClawVersion(await dockerExecNoFail(agentId, ['openclaw', '--version'], { timeoutMs: 60_000 }));
    if (version !== fromVersion) throw new Error(`The agent reports OpenClaw ${version ?? 'no version'} instead of ${fromVersion}`);

    void reapplyWhenReady(name).catch((e) => console.warn(`[rollback] credential re-apply failed on ${name}:`, redactSecret((e as Error).message, readAgentsToken())));
    updateRow(row.id, { status: 'rolled_back' });
  } catch (e) {
    updateRow(row.id, { status: 'rollback_failed', error: shortError(e) });
  }
}

// ── Resolving an old failure ─────────────────────────────────────────────────

const resolutionChecked = new Map<string, number>();
const resolutionChecking = new Set<string>();

/**
 * A `failed` or `interrupted` update is resolved only with evidence, checked now: the container
 * runs, its Gateway is ready, it reports the update's target version and the stored baseline
 * verification passes (sessions have at least their baseline events, every baseline cron job is
 * there; an unreadable cron list is not verified). The row's `status` is never rewritten, only
 * `resolved_at`, `resolution` and `verify_json` are filled. Never throws; returns true when the
 * row was resolved by this call.
 */
export async function checkUpdateResolution(agentId: string): Promise<boolean> {
  if (resolutionChecking.has(agentId) || running.has(agentId)) return false;
  resolutionChecking.add(agentId);
  resolutionChecked.set(agentId, Date.now());
  try {
    if (!isValidAgentId(agentId)) return false;
    const row = latestUpdate(agentId);
    if (!row || row.resolved_at != null || (row.status !== 'failed' && row.status !== 'interrupted')) return false;
    // Before any container work: a row that can never be resolved must not run the transcript count
    // and the cron list again on every panel open.
    const checked = await whenEligible(row, async () => {
      if (await agentBusyReason(agentId)) return false;
      const container = await inspectAgentContainer(agentId);
      const containerRunning = container?.State?.Running === true;
      const gatewayReady = containerRunning && (await probeGateway(agentId)) === 'ready';
      const version = gatewayReady ? await runningVersion(agentId) : null;

      const baseline = readUpdateBaseline(row.baseline_json);
      let now: NowVerification | null = null;
      if (baseline && gatewayReady && version === row.to_version) now = await verifyNow(agentId, baseline, { fromVersion: row.from_version, toVersion: row.to_version });

      const decision = evaluateResolution({
        status: row.status,
        resolvedAt: row.resolved_at ?? null,
        toVersion: row.to_version,
        containerRunning,
        gatewayReady,
        runningVersion: version,
        verifyJson: row.verify_json,
        error: row.error,
        hasBaseline: baseline !== null,
        cronUnreadable: now?.cronUnreadable ?? false,
        verificationOk: now ? now.error === null : null,
      });
      return { decision, now };
    });
    if (!checked) return false;
    const { decision, now } = checked;
    if (!decision.resolved || !now) return false;

    const later = laterJob(row, latestRecreate(agentId), latestRestore(agentId));
    // The update's own steps re-apply Rev4a's config; a resolution does the same before it is stamped.
    // Best-effort: a failure is logged and mentioned in the text, it does not block the resolution.
    const failures: string[] = [];
    try {
      await applyRuntimeConfig(agentId);
    } catch (e) {
      console.warn(`[agent:update] could not re-apply Rev4a's config on ${agentId}: ${redactSecret((e as Error).message, readAgentsToken())}`);
      failures.push(shortError(e));
    }
    try {
      await patchRev4aProvider(agentId);
    } catch (e) {
      console.warn(`[agent:update] provider patch failed on ${agentId}: ${redactSecret((e as Error).message, readAgentsToken())}`);
      failures.push(shortError(e));
    }
    const configNote = failures.length ? `Rev4a's config could not be re-applied: ${failures[0]}` : null;
    const text = resolutionText(row.status, row.to_version, later, configNote);
    // The write itself is guarded on status (failed/interrupted) and resolved_at IS NULL, so a
    // rollback that started during this check cannot be stamped.
    return markUpdateResolved(row.id, text, JSON.stringify(now.verification));
  } catch (e) {
    console.warn(`[agent:update] could not check the update of ${agentId} after the fact: ${redactSecret((e as Error).message, readAgentsToken())}`);
    return false;
  } finally {
    resolutionChecking.delete(agentId);
  }
}

/**
 * Separate from slow-start resolution: repair only a recorded, cron-only failure whose native
 * pre-update ownership is proven by the exact backup. The reader never writes to agent volumes.
 * No reader/evidence means a visible unresolved audit, never a name-based exemption.
 */
export async function repairRetiredCronUpdate(agentId: string, readEvidence?: PreUpdateCronEvidenceReader): Promise<boolean> {
  if (!isValidAgentId(agentId) || resolutionChecking.has(agentId) || running.has(agentId)) return false;
  const row = latestUpdate(agentId);
  if (!row || !isCronRepairCandidate(row)) return false;
  resolutionChecking.add(agentId);
  resolutionChecked.set(agentId, Date.now());
  try {
    if (await agentBusyReason(agentId)) return false;
    const storeAudit = (status: CronRepairAudit['status'], reason: string, extra: Partial<CronRepairAudit> = {}): boolean => {
      const audit: CronRepairAudit = {
        version: 1, policy: 'retired-skill-collection-review-v1', status,
        reason: shortError(new Error(reason)), checkedAtMs: Date.now(), ...extra,
      };
      const changed = recordCronRepairAudit(row, audit);
      if (changed) console.log(`[agent:update] Cron retirement audit for ${agentId}: ${audit.reason}`);
      return changed && status === 'verified';
    };
    const evidence = readEvidence
      ? await readEvidence({
        agentId, backupFile: row.backup_file!, fromVersion: row.from_version!, toVersion: row.to_version,
        baselineJson: row.baseline_json!,
      })
      : { kind: 'unavailable' as const, reason: 'Pre-update cron ownership has not been verified; the original failure and rollback remain available' };
    if (evidence.kind !== 'verified') return storeAudit('unresolved', evidence.reason);
    const baseline = baselineWithCronEvidence(row, evidence);
    if (!baseline) return storeAudit('unresolved', 'The backup does not prove the complete stored cron baseline; the original failure remains unresolved');
    const source = { file: evidence.file, sha256: evidence.sha256 };
    const container = await inspectAgentContainer(agentId);
    if (!container?.State?.Running || (await probeGateway(agentId)) !== 'ready') {
      return storeAudit('unresolved', 'The Gateway is not ready; cron retirement cannot be verified', { source });
    }
    if (await runningVersion(agentId) !== row.to_version) {
      return storeAudit('unresolved', 'The Gateway does not report the update target version; cron retirement cannot be verified', { source });
    }
    const now = await verifyNow(agentId, baseline, { fromVersion: row.from_version, toVersion: row.to_version });
    if (await agentBusyReason(agentId)) return false;
    if (now.error || !now.verification.retiredCronJobs?.length) {
      return storeAudit('unresolved', now.error ?? 'No missing job was proven to be an upstream-owned retirement', { source, verification: now.verification });
    }
    // The SQL also checks latest-row identity, original evidence and active lifecycle jobs. A
    // rollback/new operation racing the checks wins; original status/error/verify_json stay intact.
    return storeAudit('verified', 'Only the documented upstream-owned cron retirement is missing; transcript and user-job verification passed', { source, verification: now.verification });
  } catch (e) {
    console.warn(`[agent:update] Could not audit retired cron jobs on ${agentId}: ${shortError(e)}`);
    return false;
  } finally {
    resolutionChecking.delete(agentId);
  }
}

/** Both startup and bounded panel retries retain the retirement-specific evidence and SQL guards. */
async function checkFailedUpdateResolution(agentId: string, readEvidence: PreUpdateCronEvidenceReader = readPreUpdateCronEvidence): Promise<boolean> {
  const row = latestUpdate(agentId);
  return row && isCronRepairCandidate(row)
    ? repairRetiredCronUpdate(agentId, readEvidence)
    : checkUpdateResolution(agentId);
}

/**
 * At startup: every agent whose latest update failed or was interrupted is checked once, one after
 * the other. Not awaited by the caller. Retirement audits use their own evidence path; the generic
 * slow-start eligibility and verification evidence are not broadened or overwritten.
 */
export async function resolveFailedUpdatesAtStartup(readEvidence?: PreUpdateCronEvidenceReader): Promise<number> {
  let resolved = 0;
  for (const row of unresolvedFailedUpdates()) {
    const repaired = await checkFailedUpdateResolution(row.agent_id, readEvidence);
    if (repaired) {
      resolved++;
      console.log(`[agent:update] Update of ${row.agent_id} to ${row.to_version} verified after the fact`);
    }
  }
  return resolved;
}

export interface AgentUpdateView {
  id: number;
  agentId: string;
  status: AgentUpdateRow['status'];
  fromVersion: string | null;
  toVersion: string;
  backupFile: string | null;
  /** Cold backup progress while `backing_up`. */
  backupPercent: number | null;
  verification: Verification | null;
  error: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  /** A recreate or restore that finished after this failed or interrupted update: its rollback undoes it too. */
  laterJob: LaterJob | null;
  /** When a failed or interrupted update was later proved fine; null while unresolved (and for every other status). */
  resolvedAtMs: number | null;
  /** Why it was proved fine, e.g. "verified on 2026.9.9 after a slow start". */
  resolution: string | null;
  /** The pre-update backup still exists; checked only when a rollback could be offered; null = unknown. */
  backupAvailable: boolean | null;
  /** Separate cron-retirement diagnosis; original verification is retained above. */
  cronRepair: CronRepairAudit | null;
  cronAccountAdoption: CronAccountAdoption | null;
}

/** One update attempt in the read-only history. */
export interface AgentUpdateHistoryEntry {
  id: number;
  status: AgentUpdateRow['status'];
  fromVersion: string | null;
  toVersion: string;
  error: string | null;
  resolution: string | null;
  resolvedAtMs: number | null;
  backupFile: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  cronRepair: CronRepairAudit | null;
  cronAccountAdoption: CronAccountAdoption | null;
}

/** The agent's last 20 updates, newest first. */
export function agentUpdateHistory(agentId: string): AgentUpdateHistoryEntry[] {
  return updateHistory(agentId, 20).map((r) => ({
    id: r.id,
    status: r.status,
    fromVersion: r.from_version,
    toVersion: r.to_version,
    error: r.error,
    resolution: r.resolution ?? null,
    resolvedAtMs: r.resolved_at ?? null,
    backupFile: r.backup_file,
    startedAtMs: r.started_at,
    finishedAtMs: r.finished_at,
    cronRepair: readCronRepairAudit(r.cron_repair_json),
    cronAccountAdoption: readCronAccountAdoption(r.cron_account_json),
  }));
}

/** The latest update of an agent, with live backup progress. */
export async function agentUpdateView(agentId: string): Promise<AgentUpdateView | null> {
  const row = latestUpdate(agentId);
  if (!row) return null;
  const later = laterJob(row, latestRecreate(agentId), latestRestore(agentId));
  let backupPercent: number | null = null;
  // A failed or interrupted update gets re-checked in the background (at most every 5 minutes per
  // agent); the panel is not held for it, the next read shows the outcome.
  if ((row.status === 'failed' || row.status === 'interrupted') && row.resolved_at == null && dueForRecheck(resolutionChecked.get(agentId), Date.now())) {
    resolutionChecked.set(agentId, Date.now());
    void checkFailedUpdateResolution(agentId);
  }
  const active = (ACTIVE_STATUSES_FOR_VIEW as readonly string[]).includes(row.status);
  const panel = { status: row.status, resolvedAtMs: row.resolved_at ?? null, backupFile: row.backup_file, fromVersion: row.from_version, error: row.error };
  const backupAvailable = row.backup_file && (offersRollback(panel, active) || offersRollbackAnyway(panel, active))
    ? await backupAvailability(agentId, row.backup_file)
    : null;
  if (row.status === 'backing_up') backupPercent = (await coldBackupStatus(agentId))?.percent ?? null;
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    backupFile: row.backup_file,
    backupPercent,
    verification: row.verify_json ? (JSON.parse(row.verify_json) as Verification) : null,
    error: row.error,
    startedAtMs: row.started_at,
    finishedAtMs: row.finished_at,
    laterJob: later,
    resolvedAtMs: row.resolved_at ?? null,
    resolution: row.resolution ?? null,
    backupAvailable,
    cronRepair: readCronRepairAudit(row.cron_repair_json),
    cronAccountAdoption: readCronAccountAdoption(row.cron_account_json),
  };
}

function readCronAccountAdoption(json: string | null | undefined): CronAccountAdoption | null {
  try { const result = json ? JSON.parse(json) as CronAccountAdoption : null; return result && typeof result.note === 'string' ? result : null; } catch { return null; }
}
