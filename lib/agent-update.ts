/**
 * The Update action: move one agent to a newer supported OpenClaw version.
 *
 * Each step is recorded in `agent_upgrades` before it starts:
 *
 *   pending     preflight: agent running, target downloaded, newer and supported,
 *               no backup or update already running
 *   (baseline)  transcript events per session and cron job names, read inside the agent
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
import { BACKUP_VOLUME, coldBackupStatus, isColdBackupRunning, startColdBackup, waitForColdBackup } from '@/lib/cold-backup';
import { inspectAgentContainer, recreateAgentContainer, startAndVerifyContainer, type AgentContainerInspect } from '@/lib/agent-recreate';
import { applyRuntimeConfig } from '@/lib/agent-setup';
import { waitForGatewayReady } from '@/lib/agent-readiness';
import { patchRev4aProvider } from '@/app/api/gateway/sync';
import { activeUpdateAgentIds, insertUpdate, latestUpdate, markInterruptedUpdates, updateRow, type AgentUpdateRow } from '@/lib/agent-update-state';
import { agentBusyReason } from '@/lib/agent-busy';

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

const CRON_LIST = [
  'export OPENCLAW_GATEWAY_PORT=3000',
  'if [ -f /root/.agent-token ]; then OPENCLAW_GATEWAY_TOKEN=$(head -1 /root/.agent-token | tr -d "[:space:]"); export OPENCLAW_GATEWAY_TOKEN; fi',
  'exec openclaw cron list --all --json',
].join('; ');

/** Names of the agent's cron jobs; null when the list cannot be read. */
async function cronJobNames(container: string): Promise<string[] | null> {
  const out = await dockerExecNoFail(container, ['sh', '-c', CRON_LIST], { timeoutMs: 120_000 });
  const start = out.search(/[{[]/);
  if (start === -1) return null;
  try {
    const data = JSON.parse(out.slice(start)) as unknown;
    const jobs = Array.isArray(data) ? data : ((data as { jobs?: unknown[] })?.jobs ?? []);
    return (jobs as { name?: string; id?: string }[]).map((j) => j.name ?? j.id ?? '').filter(Boolean).sort();
  } catch {
    return null;
  }
}

async function runningVersion(container: string): Promise<string | null> {
  const body = await dockerExecNoFail(container, ['curl', '-s', '--max-time', '3', 'http://127.0.0.1:3000/startupz'], { timeoutMs: 10_000 });
  try {
    return parseOpenClawVersion(String((JSON.parse(body) as { version?: unknown }).version ?? ''));
  } catch {
    return null;
  }
}

interface Baseline {
  transcripts: Record<string, number>;
  cronJobs: string[] | null;
}

export interface Verification {
  sessions: number;
  /** Sessions with fewer events than before, or gone: `{ session, before, after }`. */
  lostEvents: { session: string; before: number; after: number }[];
  /** Cron jobs present before and missing after; null when either list could not be read. */
  missingCronJobs: string[] | null;
  ok: boolean;
}

export function verify(baseline: Baseline, transcripts: Record<string, number>, cronJobs: string[] | null): Verification {
  const lostEvents = Object.entries(baseline.transcripts)
    .filter(([session, before]) => (transcripts[session] ?? 0) < before)
    .map(([session, before]) => ({ session, before, after: transcripts[session] ?? 0 }));
  const missingCronJobs = baseline.cronJobs && cronJobs
    ? baseline.cronJobs.filter((name) => !cronJobs.includes(name))
    : null;
  return {
    sessions: Object.keys(baseline.transcripts).length,
    lostEvents,
    missingCronJobs,
    ok: lostEvents.length === 0 && (missingCronJobs === null || missingCronJobs.length === 0),
  };
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
    throw e;
  }
}

async function runUpdateStart(agentId: string, requestedVersion?: string): Promise<number> {
  const container = await inspectAgentContainer(agentId);
  if (!container) throw new UpdateRefusedError(`No container found with AGENT_ID '${agentId}'`);
  if (!container.State?.Running) throw new UpdateRefusedError('Start the agent before updating it: its data is counted while it runs');
  const name = (container.Name ?? '').replace(/^\//, '');

  const images = await listLocalAgentImages();
  const fromVersion = await containerOpenClawVersion({ name, imageId: container.Image ?? '', running: true }, images);
  if (!fromVersion) throw new UpdateRefusedError('The OpenClaw version this agent runs could not be read');

  const toVersion = requestedVersion ?? newestLocalSupportedVersion(images);
  if (!toVersion || !isSupportedVersion(toVersion)) throw new UpdateRefusedError('No supported OpenClaw version to update to is downloaded');
  if (!(await localVersionExists(toVersion))) throw new UpdateRefusedError(`OpenClaw ${toVersion} is not downloaded`);
  if (compareVersions(toVersion, fromVersion) <= 0) {
    throw new UpdateRefusedError(`The agent already runs OpenClaw ${fromVersion}; ${toVersion} is not newer`);
  }

  const id = insertUpdate(agentId, fromVersion, toVersion);
  void runUpdate(id, agentId, name, fromVersion, toVersion).finally(() => running.delete(agentId));
  return id;
}

async function runUpdate(id: number, agentId: string, name: string, fromVersion: string, toVersion: string): Promise<void> {
  let stopped = false;
  try {
    const baseline: Baseline = { transcripts: await countTranscripts(name), cronJobs: await cronJobNames(name) };
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

    if (!(await waitForGatewayReady(agentId, MIGRATION_READY_TIMEOUT_MS))) {
      throw new Error(`OpenClaw ${toVersion} did not finish starting within ${MIGRATION_READY_TIMEOUT_MS / 60_000} minutes`);
    }
    const version = await runningVersion(agentId);
    if (version !== toVersion) throw new Error(`The agent reports OpenClaw ${version ?? 'no version'} instead of ${toVersion}`);

    await applyRuntimeConfig(agentId);
    try {
      await patchRev4aProvider(agentId);
    } catch (e) {
      console.error('[agent:update] provider patch failed:', (e as Error).message);
    }

    updateRow(id, { status: 'verifying' });
    const transcriptsAfter = await countTranscripts(agentId);
    const cronAfter = await cronJobNames(agentId);
    if (baseline.cronJobs?.length && cronAfter === null) {
      // Unreadable is not "no jobs": refuse to call the update verified rather than
      // report `done` while cron loss would be undetectable.
      throw new Error('The cron job list could not be read after the update, so the verification is incomplete');
    }
    const result = verify(baseline, transcriptsAfter, cronAfter);
    updateRow(id, { verify_json: JSON.stringify(result) });
    if (!result.ok) {
      throw new Error(
        result.lostEvents.length
          ? `${result.lostEvents.length} session(s) have fewer transcript events than before the update`
          : `Cron jobs missing after the update: ${(result.missingCronJobs ?? []).join(', ')}`,
      );
    }

    updateRow(id, { status: 'done' });

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

/** The useful part of an error for the panel: a `docker exec` failure carries a whole stack trace. */
function shortError(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
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
  if (ids.size === 0) return 0;
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
    { name: (container.Name ?? '').replace(/^\//, ''), imageId: container.Image ?? '', running: container.State?.Running === true },
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

async function backupFileExists(file: string): Promise<boolean> {
  try {
    await runDocker(
      ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, 'alpine', 'sh', '-c', 'test -f "/backup/$FILE"'],
      { timeoutMs: 60_000, env: { FILE: file } },
    );
    return true;
  } catch {
    return false;
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
  if (!(await backupFileExists(row.backup_file))) {
    throw new UpdateRefusedError(`The pre-update backup ${row.backup_file} no longer exists`);
  }
  const container = await inspectAgentContainer(agentId);
  if (!container) throw new UpdateRefusedError(`No container found with AGENT_ID '${agentId}'`);

  updateRow(row.id, { status: 'rolling_back', error: null });
  void runRollback(row, container).finally(() => running.delete(agentId));
  return row.id;
}

/**
 * Restore exactly the pre-update state: the volume from the backup, the container on the
 * previous image. Rev4a's config is not re-applied — the restored `openclaw.json` is the
 * one that version accepted.
 */
async function runRollback(row: AgentUpdateRow, container: AgentContainerInspect): Promise<void> {
  const agentId = row.agent_id;
  const fromVersion = row.from_version as string;
  const file = row.backup_file as string;
  try {
    if (!(await localVersionExists(fromVersion))) {
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

    await runDocker(
      [
        'run', '--rm',
        '-v', `agent-${agentId}-data:/target`,
        '-v', `${BACKUP_VOLUME}:/backup`,
        'alpine', 'sh', '-c',
        'rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null; tar xzf "/backup/$FILE" -C /target',
      ],
      { timeoutMs: RESTORE_TIMEOUT_MS, env: { FILE: file } },
    );

    await recreateAgentContainer(agentId, container, localImageRef(fromVersion));
    if (!(await waitForGatewayReady(agentId, ROLLBACK_READY_TIMEOUT_MS))) {
      throw new Error(`OpenClaw ${fromVersion} did not finish starting within ${ROLLBACK_READY_TIMEOUT_MS / 60_000} minutes`);
    }
    const version = parseOpenClawVersion(await dockerExecNoFail(agentId, ['openclaw', '--version'], { timeoutMs: 60_000 }));
    if (version !== fromVersion) throw new Error(`The agent reports OpenClaw ${version ?? 'no version'} instead of ${fromVersion}`);

    updateRow(row.id, { status: 'rolled_back' });
  } catch (e) {
    updateRow(row.id, { status: 'rollback_failed', error: shortError(e) });
  }
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
}

/** The latest update of an agent, with live backup progress. */
export async function agentUpdateView(agentId: string): Promise<AgentUpdateView | null> {
  const row = latestUpdate(agentId);
  if (!row) return null;
  let backupPercent: number | null = null;
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
  };
}
