/**
 * A recreate or restore that finished after a failed or interrupted update.
 *
 * The rollback of such an update restores its pre-update backup, so it also undoes that later
 * recreate or restore and drops everything the agent did since the backup. The panel says so next
 * to the failure and in the rollback confirmation. The rollback itself is never hidden or refused:
 * neither a finished recreate (it proves the container started) nor a finished restore (it may have
 * put the same pre-update data back on the new version) proves the data is intact, and the
 * rollback can be the only way back to the previous version.
 *
 * Pure and dependency-free on purpose (a unit test imports it directly). Computed at read time,
 * nothing is stored.
 */

export interface FailedUpdate {
  status: string;
  finished_at: number | null;
  updated_at: number;
}

export interface FinishedJob {
  status: string;
  finished_at: number | null;
}

export type LaterJob = { kind: 'recreate' | 'restore'; atMs: number };

/** A job that finished successfully strictly after `endedAt`. */
function doneAfter(job: FinishedJob | null | undefined, endedAt: number): job is FinishedJob & { finished_at: number } {
  return !!job && job.status === 'done' && typeof job.finished_at === 'number' && job.finished_at > endedAt;
}

/**
 * The agent's latest recreate or restore when it finished `done` after a `failed` or `interrupted`
 * update ended (`finished_at`, else `updated_at`); the more recent of the two when both did.
 */
export function laterJob(
  update: FailedUpdate,
  latestRecreate: FinishedJob | null,
  latestRestore: FinishedJob | null,
): LaterJob | null {
  if (update.status !== 'failed' && update.status !== 'interrupted') return null;
  const endedAt = update.finished_at ?? update.updated_at;
  const recreate: LaterJob | null = doneAfter(latestRecreate, endedAt) ? { kind: 'recreate', atMs: latestRecreate.finished_at } : null;
  const restore: LaterJob | null = doneAfter(latestRestore, endedAt) ? { kind: 'restore', atMs: latestRestore.finished_at } : null;
  if (recreate && restore) return restore.atMs > recreate.atMs ? restore : recreate;
  return recreate ?? restore;
}
