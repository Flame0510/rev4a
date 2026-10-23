/**
 * Two pure pieces of the agent update flow, dependency-free on purpose (unit tests import this file
 * directly):
 *
 *  1. {@link finishAfterRecreate}: what an update does once the container runs on the new image.
 *     A slow start (a large migration) is not a failure: after the first window Rev4a keeps waiting
 *     in the background, and when the Gateway finally answers it runs exactly the steps that were
 *     left (Rev4a config, provider patch, verification against the stored baseline).
 *  2. {@link evaluateResolution}: whether a `failed` or `interrupted` update has since been proved
 *     fine. Resolution needs real evidence, checked now: the container runs, its Gateway is ready,
 *     it reports the target version and the stored baseline verification passes. A later recreate
 *     or restore alone proves nothing (lib/agent-update-later-job.ts), so those rows stay red.
 *
 * Nothing here rewrites a row's `status`: an older Rev4a reads the same rows as before.
 */

// ── 1. Finishing an update after the recreate ────────────────────────────────

export interface FinishDeps {
  /** Wait for the Gateway for at most `timeoutMs`; true when it finished starting. */
  waitReady(timeoutMs: number): Promise<boolean>;
  /** The OpenClaw version the running Gateway reports. */
  runningVersion(): Promise<string | null>;
  /** The agent container as Docker sees it now; null when it is gone or cannot be inspected. */
  containerState(): Promise<ContainerState | null>;
  /** The slow start was noticed: the first window passed without the Gateway being ready. */
  onSlowStart(): void;
  /** The Gateway is ready on the target version: re-apply Rev4a's own config and the provider patch. */
  applyConfig(): Promise<void>;
  /** The status moves to `verifying`. */
  onVerifying(): void;
  /** Compare the agent with its baseline; throws when the verification is incomplete or fails. */
  verify(): Promise<void>;
}

/** What the extra wait needs to know about the container. */
export interface ContainerState {
  running: boolean;
  /** Docker's `State.Status` ("running", "restarting", "exited", ...). */
  status: string;
  restartCount: number;
}

/** The Gateway restarting this many times since the recreate is a crash loop, not a slow start. */
export const CRASH_LOOP_RESTARTS = 3;

export interface FinishTimings {
  /** The first window, as before. */
  firstWindowMs: number;
  /** How much longer Rev4a keeps waiting after the first window. */
  extraWindowMs: number;
  /** Length of each wait in the extra window; inside each wait the Gateway is probed every 2 s (waitForGatewayReady). */
  checkEveryMs: number;
  /** Pause between reads of the version when the Gateway is ready but reports none (retried 3 times). */
  versionRetryMs: number;
}

export const DEFAULT_FINISH_TIMINGS: FinishTimings = {
  firstWindowMs: 10 * 60 * 1000,
  extraWindowMs: 30 * 60 * 1000,
  checkEveryMs: 30 * 1000,
  versionRetryMs: 5 * 1000,
};

const VERSION_RETRIES = 3;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Why waiting longer is pointless, or null when the container is still plausibly starting (or cannot be told). */
function deadContainerReason(state: ContainerState | null, baselineRestarts: number, toVersion: string): string | null {
  if (!state) return `The agent container is gone, so OpenClaw ${toVersion} cannot finish starting`;
  const restarting = state.status === 'restarting';
  if (!state.running && !restarting) return `The agent container exited before OpenClaw ${toVersion} finished starting (state: ${state.status})`;
  const restarts = state.restartCount - baselineRestarts;
  if (restarts >= CRASH_LOOP_RESTARTS) return `The gateway keeps restarting (${restarts} restarts since the update), so OpenClaw ${toVersion} will not finish starting`;
  return null;
}

/**
 * Wait for the Gateway (first window, then a longer background window), then run the remaining steps.
 * Throws when the Gateway never becomes ready, reports another version, or the verification fails:
 * the caller marks the update `failed` with the message.
 */
export async function finishAfterRecreate(
  deps: FinishDeps,
  toVersion: string,
  timings: FinishTimings = DEFAULT_FINISH_TIMINGS,
): Promise<void> {
  // Restarts are counted from the recreate; a container that cannot be inspected is not a reason to stop.
  const baselineRestarts = (await deps.containerState().catch(() => null))?.restartCount ?? 0;
  let ready = await deps.waitReady(timings.firstWindowMs);
  if (!ready) {
    // A zero or negative step would make the window count infinite.
    const step = Math.max(1, timings.checkEveryMs);
    const windows = Math.max(1, Math.ceil(timings.extraWindowMs / step));
    let noted = false;
    for (let i = 0; i < windows && !ready; i++) {
      let state: ContainerState | null;
      let known = true;
      try { state = await deps.containerState(); } catch { state = null; known = false; }
      const dead = known ? deadContainerReason(state, baselineRestarts, toVersion) : null;
      if (dead) throw new Error(dead);
      if (!noted) { deps.onSlowStart(); noted = true; }
      ready = await deps.waitReady(step);
    }
  }
  if (!ready) {
    const total = (timings.firstWindowMs + timings.extraWindowMs) / 60_000;
    throw new Error(`OpenClaw ${toVersion} did not finish starting within ${total} minutes`);
  }
  // A Gateway that answers ready can still be a moment from reporting its version: read it again before failing.
  let version = await deps.runningVersion();
  for (let i = 0; version === null && i < VERSION_RETRIES; i++) {
    await sleep(timings.versionRetryMs);
    version = await deps.runningVersion();
  }
  if (version !== toVersion) {
    throw new Error(version === null ? `The agent reports no version instead of OpenClaw ${toVersion}` : `The agent reports OpenClaw ${version} instead of ${toVersion}`);
  }

  await deps.applyConfig();
  deps.onVerifying();
  await deps.verify();
}

// ── 2. Resolving an old failure with evidence ────────────────────────────────

export interface ResolutionInput {
  status: string;
  /** Already resolved: nothing to do. */
  resolvedAt: number | null;
  toVersion: string;
  /** The container is running now. */
  containerRunning: boolean;
  /** Its Gateway answers ready now. */
  gatewayReady: boolean;
  /** The version the Gateway reports now. */
  runningVersion: string | null;
  /** The stored baseline could be read; without one nothing can be verified. */
  hasBaseline: boolean;
  /** The `verify_json` stored by the update itself; a row that produced a verification result is never eligible. */
  verifyJson: string | null;
  /** The `error` stored on the row; only a slow start or an interruption is eligible. */
  error: string | null;
  /** The baseline had cron jobs but the list cannot be read now: not verified. */
  cronUnreadable: boolean;
  /** The baseline verification run now; null when it could not run. */
  verificationOk: boolean | null;
}

export type ResolutionDecision = { resolved: true } | { resolved: false; reason: string };

/** Only a `failed` or `interrupted` update can be resolved; `done` and rollbacks are left as they are. */
export function isResolvable(status: string): boolean {
  return status === 'failed' || status === 'interrupted';
}

/** Errors of an update that only ran out of patience: the Gateway was slow, nothing was found wrong. */
// Anchored to the texts runUpdate itself writes, so no other failure that merely mentions a start qualifies.
const SLOW_START_ERROR = /^OpenClaw \S+ (did not finish starting within|is still starting after) /;
// An interruption of an update step. An interrupted ROLLBACK (": rolling_back") is never eligible: the
// volume may already hold the pre-update backup, and hiding its Roll back would strand the operator.
const INTERRUPTED_UPDATE_STEP = /^Rev4a restarted while this step was running: (migrating|verifying)$/;

/**
 * Eligibility for resolution, from what the update itself recorded. Never a row that produced a
 * verification result (ok or not: a recorded failure is not erased by later activity), never a
 * version mismatch ("reports OpenClaw X instead of Y"), a backup failure or any other error. Only an
 * update that stopped before verifying: a slow start (timeout) or an interruption.
 */
export function isEligibleForResolution(status: string, verifyJson: string | null, error: string | null): boolean {
  if (!isResolvable(status)) return false;
  if (verifyJson !== null) return false;
  if (error === null) return false;
  if (status === 'interrupted') return INTERRUPTED_UPDATE_STEP.test(error);
  return SLOW_START_ERROR.test(error);
}

/**
 * Runs `gather` (everything that touches the container: busy check, probe, version, transcript count,
 * cron list) only for a row that can be resolved at all; any other row returns null with no container call.
 */
export async function whenEligible<T>(
  row: { status: string; verify_json: string | null; error: string | null },
  gather: () => Promise<T>,
): Promise<T | null> {
  if (!isEligibleForResolution(row.status, row.verify_json, row.error)) return null;
  return gather();
}

export function evaluateResolution(input: ResolutionInput): ResolutionDecision {
  if (!isResolvable(input.status)) return { resolved: false, reason: 'not a failed or interrupted update' };
  if (input.resolvedAt !== null) return { resolved: false, reason: 'already resolved' };
  if (!isEligibleForResolution(input.status, input.verifyJson, input.error)) {
    return { resolved: false, reason: 'the update recorded a verification result or a failure that later activity cannot erase' };
  }
  if (!input.containerRunning) return { resolved: false, reason: 'the agent is not running' };
  if (!input.gatewayReady) return { resolved: false, reason: 'the Gateway is not ready' };
  if (input.runningVersion !== input.toVersion) {
    return { resolved: false, reason: `the agent reports OpenClaw ${input.runningVersion ?? 'no version'}, not ${input.toVersion}` };
  }
  if (!input.hasBaseline) return { resolved: false, reason: 'the update stored no baseline to verify against' };
  if (input.cronUnreadable) return { resolved: false, reason: 'the cron job list cannot be read' };
  if (input.verificationOk !== true) return { resolved: false, reason: 'the verification did not pass' };
  return { resolved: true };
}

/** The day in UTC: the server has no way to know the operator's time zone. */
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The sentence stored as `resolution`: why and when the failure was proved harmless. */
export function resolutionText(
  status: string,
  toVersion: string,
  later: { kind: 'recreate' | 'restore'; atMs: number } | null,
  configNote?: string | null,
): string {
  const cause = status === 'interrupted' ? 'after Rev4a restarted during the update' : 'after a slow start';
  const note = later ? ` (the agent was ${later.kind === 'restore' ? 'restored' : 'recreated'} on ${isoDay(later.atMs)} UTC)` : '';
  const config = configNote ? `; ${configNote}` : '';
  return `verified on ${toVersion} ${cause}${note}${config}`;
}

/** `verify_json` to store after the update's own verification: nothing when the cron list was unreadable (incomplete, not a result). */
export function verifyJsonForStore(verification: unknown, cronUnreadable: boolean): string | null {
  return cronUnreadable ? null : JSON.stringify(verification);
}

// ── SQL kept here so tests run it on a real temp database (db is a better-sqlite3 handle) ──

interface SqlDb { prepare(sql: string): { run(...args: unknown[]): { changes: number | bigint } } }

/** Stamp the resolution; only on a still failed/interrupted, unresolved row (a rollback racing the check wins). */
export function markResolvedSql(db: SqlDb, id: number, resolution: string, verifyJson: string, now: number): boolean {
  const info = db.prepare(
    "UPDATE agent_upgrades SET resolved_at = ?, resolution = ?, verify_json = ? WHERE id = ? AND resolved_at IS NULL AND status IN ('failed', 'interrupted')",
  ).run(now, resolution, verifyJson, id);
  return Number(info.changes) > 0;
}

/** The slow-start note "Rev4a keeps waiting" is wrong once Rev4a restarted: use the standard interrupted text (other errors kept). */
export function clearStaleSlowStartNote(db: SqlDb): number {
  const info = db.prepare(
    "UPDATE agent_upgrades SET error = 'Rev4a restarted while this step was running: migrating' WHERE status = 'interrupted' AND error LIKE '% Rev4a keeps waiting'",
  ).run();
  return Number(info.changes);
}

/** Minimum time between two evidence checks of one agent. */
export const RESOLUTION_RECHECK_MS = 5 * 60 * 1000;

/** True when an agent may be re-checked now (never checked, or the last check is old enough). */
export function dueForRecheck(lastCheckedMs: number | undefined, nowMs: number): boolean {
  return lastCheckedMs === undefined || nowMs - lastCheckedMs >= RESOLUTION_RECHECK_MS;
}

// ── Panel mapping ────────────────────────────────────────────────────────────

export interface PanelUpdate {
  status: string;
  resolvedAtMs?: number | null;
  backupFile: string | null;
  fromVersion: string | null;
  /** The row's `error`; an interrupted rollback is never a resolved failure. */
  error?: string | null;
  /** The pre-update backup file still exists; false = deleted, null/undefined = unknown (the server still refuses). */
  backupAvailable?: boolean | null;
}

/** An interruption that cut a ROLLBACK: the volume may already hold the pre-update backup. */
const INTERRUPTED_ROLLBACK = /^Rev4a restarted while this step was running: rolling_back$/;

/** A failed or interrupted update that has been proved fine since. */
export function isResolvedFailure(update: PanelUpdate): boolean {
  if (update.error && INTERRUPTED_ROLLBACK.test(update.error)) return false;
  return isResolvable(update.status) && typeof update.resolvedAtMs === 'number';
}

/** Unresolved failures keep the red badge; resolved ones show a muted line. */
export function showsRedFailure(update: PanelUpdate): boolean {
  return isResolvable(update.status) && !isResolvedFailure(update);
}

const ROLLBACK_STATUSES = ['done', 'failed', 'interrupted', 'rollback_failed'];

/** Whether the status area offers the normal Roll back: never for a resolved failure (see {@link offersRollbackAnyway}). */
export function offersRollback(update: PanelUpdate, active: boolean): boolean {
  return !active && update.backupAvailable !== false && ROLLBACK_STATUSES.includes(update.status) && !isResolvedFailure(update) && !!update.backupFile && !!update.fromVersion;
}

/**
 * A resolved failure of the LATEST update can still be rolled back, but never by accident: the panel shows a
 * secondary "Roll back anyway…" whose confirmation needs the agent's name typed. Older history rows have none.
 */
export function offersRollbackAnyway(update: PanelUpdate, active: boolean): boolean {
  return !active && update.backupAvailable !== false && isResolvedFailure(update) && !!update.backupFile && !!update.fromVersion;
}

/**
 * The backup is known to be deleted, so going back is impossible: the panel shows a muted line instead of a
 * Roll back (any rollback status, resolved or not, with the data a rollback would have needed).
 */
export function backupWasDeleted(update: PanelUpdate, active: boolean): boolean {
  return !active && update.backupAvailable === false && ROLLBACK_STATUSES.includes(update.status) && !!update.backupFile && !!update.fromVersion;
}
