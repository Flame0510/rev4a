/**
 * Moving the backups of older releases out of the Docker volume `rev4a-backups` into
 * `<REV4A_DATA>/backups`.
 *
 * This file is the planner, the resumable runner and the status; it holds no Docker or file
 * access of its own (everything comes in through `MigrationDeps`), so the order of the
 * steps, the resume rules and the stop conditions are tested with a fake runner. The real
 * dependencies are in lib/backups-migration-host.ts.
 *
 * One file at a time: the helper copies it to `<name>.migrating`, reads it back with
 * `tar -tzf`, renames it, gives it to Rev4a's user; only then is it deleted from the volume.
 * Nothing is deleted before a verified copy exists. A leftover `.migrating` (Rev4a stopped
 * mid-copy) is simply redone; a second run finds nothing to do.
 */

import { agentIdOfBackupName } from '@/lib/backups-names';

export type MigrationStatus = 'pending' | 'running' | 'done' | 'stopped';

export interface MigrationState {
  status: MigrationStatus;
  /** Why it stopped; null otherwise. */
  reason: string | null;
  /** Files moved since this process started. */
  moved: number;
  /** Files still to move when the last pass looked. */
  remaining: number;
  /** File being moved right now. */
  current: string | null;
  /** Files left in the volume because their copy did not verify; the rest of the files were still moved. */
  skipped: { name: string; reason: string }[];
  /**
   * True once the legacy volume is known to be gone (it never existed, or the migration removed it).
   * Optional and additive: absent means "not known to be gone", so a volume that may still hold backups is
   * never skipped. A `done` state with this unset means the volume was kept (a container uses it, or it
   * holds other files).
   */
  volumeRemoved?: boolean;
}

/** A copy that did not read back or has another size. The file stays in the volume and the migration goes on with the next one. */
export class CopyVerificationError extends Error {}

export interface FileSize {
  name: string;
  sizeBytes: number;
}

export type MigrationAction = 'copy' | 'drop-volume-copy' | 'conflict' | 'remove-stale';

export interface MigrationStep extends FileSize {
  action: MigrationAction;
}

/**
 * Free space kept beyond the file being copied. 1 GiB: the data folder and Docker's storage can be on
 * different filesystems, so the copy grows the data filesystem and must leave it room to breathe.
 */
export const MIGRATION_HEADROOM_BYTES = 1024 * 1024 * 1024;

/**
 * What to do, from the archives in the volume and the files in the directory (finished archives and
 * `.migrating` leftovers):
 * - in both with the same size: the directory copy is a finished, verified one (it only gets its final name
 *   after the read-back), so the volume copy is dropped without copying again;
 * - in both with different sizes: a conflict, nothing is touched;
 * - only in the volume: copy (a `.migrating` leftover for it is overwritten);
 * - a `.migrating` leftover whose source is gone: removed.
 * Smallest first, so most files are safe quickly.
 */
export function planMigration(volumeFiles: FileSize[], dirFiles: FileSize[]): MigrationStep[] {
  const dir = new Map(dirFiles.map((f) => [f.name, f.sizeBytes]));
  const inVolume = new Set(volumeFiles.map((f) => f.name));
  const steps: MigrationStep[] = [];
  for (const v of volumeFiles) {
    const there = dir.get(v.name);
    if (there === undefined) steps.push({ ...v, action: 'copy' });
    else if (there === v.sizeBytes) steps.push({ ...v, action: 'drop-volume-copy' });
    else steps.push({ ...v, action: 'conflict' });
  }
  for (const f of dirFiles) {
    if (!f.name.endsWith('.migrating')) continue;
    const final = f.name.slice(0, -'.migrating'.length);
    if (!inVolume.has(final)) steps.push({ ...f, action: 'remove-stale' });
  }
  return steps.sort((a, b) => a.sizeBytes - b.sizeBytes || a.name.localeCompare(b.name));
}

/** The agent id in an archive name (every shape lib/backups-names.ts knows), or null. */
export function agentIdOfBackup(name: string): string | null {
  return agentIdOfBackupName(name);
}

export interface MigrationDeps {
  /** Whether the volume exists; null when Docker cannot answer. */
  volumeExists(): Promise<boolean | null>;
  listVolumeArchives(): Promise<FileSize[]>;
  /** Finished archives and `.migrating` leftovers in the directory. */
  listDirFiles(): FileSize[];
  /** Free bytes in the directory's filesystem; null when unknown (the helper checks too). */
  freeBytes(): number | null;
  /** Whether a backup, restore, update or rollback of the file's agent is running. */
  isBusy(name: string): Promise<boolean>;
  /** Copy, verify, rename and hand over one file. Throws on any failure; leaves at most a `.migrating`. */
  copyVerified(name: string): Promise<void>;
  removeFromVolume(name: string): Promise<void>;
  /** `*.tar.gz.partial` files an older release left in the volume. */
  listVolumeTemps(): Promise<string[]>;
  removeDirFile(name: string): void;
  /** Whether nothing is left in the volume at all. */
  volumeEmpty(): Promise<boolean>;
  volumeInUse(): Promise<boolean>;
  removeVolume(): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/** The stop reason when Docker could not be asked; the only one the host retries on its own. */
export const DOCKER_SILENT_REASON = 'Docker did not answer';
const DOCKER_RETRIES = 3;
const DOCKER_RETRY_MS = 30_000;
const BUSY_PASSES = 10;
const BUSY_WAIT_MS = 30_000;

/**
 * Run the migration to its end or to a stop. Never throws: every outcome lands in the state.
 * `report` receives the state after every change.
 */
export async function runMigration(deps: MigrationDeps, report: (s: MigrationState) => void = () => {}): Promise<MigrationState> {
  const state: MigrationState = { status: 'running', reason: null, moved: 0, remaining: 0, current: null, skipped: [] };
  const skippedNames = new Set<string>();
  const push = () => report({ ...state, skipped: [...state.skipped] });
  const stop = (reason: string): MigrationState => {
    state.status = 'stopped';
    state.reason = reason;
    state.current = null;
    deps.log(`Backups migration stopped: ${reason}. It resumes at the next start.`);
    push();
    return state;
  };
  push();

  try {
    let exists: boolean | null = null;
    for (let attempt = 0; attempt < DOCKER_RETRIES; attempt++) {
      exists = await deps.volumeExists();
      if (exists !== null) break;
      if (attempt < DOCKER_RETRIES - 1) await deps.sleep(DOCKER_RETRY_MS);
    }
    if (exists === null) return stop(DOCKER_SILENT_REASON);
    if (exists === false) {
      state.status = 'done';
      state.volumeRemoved = true;
      push();
      return state;
    }

    // An unfinished write of an older release is no backup: drop it so the volume can empty.
    for (const temp of await deps.listVolumeTemps()) {
      if (await deps.isBusy(temp.replace(/\.partial$/, ''))) continue;
      await deps.removeFromVolume(temp);
      deps.log(`Backups migration: removed the unfinished ${temp} from the volume`);
    }

    for (let pass = 0; pass < BUSY_PASSES; pass++) {
      const steps = planMigration(await deps.listVolumeArchives(), deps.listDirFiles());
      const work = steps.filter((s) => s.action !== 'conflict' && !skippedNames.has(s.name));
      state.remaining = work.filter((s) => s.action === 'copy').length;
      push();
      if (work.length === 0) break;
      if (pass === 0) {
        const bytes = work.filter((s) => s.action === 'copy').reduce((n, s) => n + s.sizeBytes, 0);
        deps.log(`Backups migration: ${state.remaining} file(s), ${(bytes / 1024 / 1024).toFixed(0)} MB, from the rev4a-backups volume to the backups folder`);
      }

      let deferred = 0;
      for (const step of work) {
        if (step.action === 'remove-stale') {
          deps.removeDirFile(step.name);
          continue;
        }
        if (await deps.isBusy(step.name)) {
          deferred++;
          continue;
        }
        state.current = step.name;
        push();
        if (step.action === 'drop-volume-copy') {
          await deps.removeFromVolume(step.name);
          deps.log(`Backups migration: ${step.name} was already in the backups folder; the volume copy is removed`);
          continue;
        }
        // A leftover `.migrating` is removed before the copy, so its size counts as free.
        const leftover = deps.listDirFiles().find((f) => f.name === `${step.name}.migrating`)?.sizeBytes ?? 0;
        const free = deps.freeBytes();
        if (free !== null && free + leftover < step.sizeBytes + MIGRATION_HEADROOM_BYTES) {
          return stop(`not enough free space in the backups folder for ${step.name} (${Math.ceil(step.sizeBytes / 1024 / 1024)} MB needed, ${Math.floor(free / 1024 / 1024)} MB free)`);
        }
        try {
          await deps.copyVerified(step.name);
        } catch (e) {
          if (e instanceof CopyVerificationError) {
            // One unreadable archive must not block the larger ones behind it: keep it in the volume, report it, go on.
            skippedNames.add(step.name);
            state.skipped.push({ name: step.name, reason: e.message });
            state.remaining = Math.max(0, state.remaining - 1);
            state.current = null;
            deps.log(`Backups migration: ${step.name} was left in the volume (${e.message}); going on with the next file`);
            push();
            continue;
          }
          return stop(`${step.name} could not be copied: ${(e as Error).message}`);
        }
        // The agent may have started a backup or an update while the copy ran: leave the volume copy for the next pass.
        if (await deps.isBusy(step.name)) {
          deferred++;
          deps.log(`Backups migration: ${step.name} is copied but its agent became busy; the volume copy is removed later`);
          continue;
        }
        await deps.removeFromVolume(step.name);
        state.moved++;
        state.remaining = Math.max(0, state.remaining - 1);
        deps.log(`Backups migration: ${state.moved} moved, ${state.remaining} left (${step.name})`);
        push();
      }
      state.current = null;
      if (deferred === 0) break;
      deps.log(`Backups migration: ${deferred} file(s) belong to an agent that is busy; trying again shortly`);
      await deps.sleep(BUSY_WAIT_MS);
    }

    const left = planMigration(await deps.listVolumeArchives(), deps.listDirFiles()).filter((s) => !skippedNames.has(s.name));
    if (left.some((s) => s.action === 'copy' || s.action === 'drop-volume-copy')) return stop('some files belong to agents that stayed busy');
    if (left.some((s) => s.action === 'remove-stale')) return stop('a leftover temporary copy in the backups folder could not be removed');
    if (state.skipped.length > 0) {
      return stop(`${state.skipped.length} file(s) could not be verified after copying and were left in the volume: ${state.skipped.map((k) => `${k.name} (${k.reason})`).join('; ')}`);
    }
    const conflictsLeft = left.filter((s) => s.action === 'conflict').length;
    if (conflictsLeft > 0) return stop(`${conflictsLeft} file(s) exist in both places with different sizes and were left in the volume`);

    if (await deps.volumeEmpty()) {
      if (await deps.volumeInUse()) {
        deps.log('Backups migration: the rev4a-backups volume is empty but a container still uses it; it is kept');
      } else {
        await deps.removeVolume();
        state.volumeRemoved = true;
        deps.log('Backups migration done: the empty rev4a-backups volume is removed');
      }
    } else {
      deps.log('Backups migration done: the rev4a-backups volume holds other files and is kept');
    }
    state.status = 'done';
    state.current = null;
    push();
    return state;
  } catch (e) {
    return stop((e as Error).message || String(e));
  }
}

// ── Status, shared across the server's bundles ───────────────────────────────

const g = globalThis as unknown as { __rev4aBackupsMigration?: MigrationState };

export function recordMigrationState(s: MigrationState): void {
  g.__rev4aBackupsMigration = s;
}

/** The last state this process reported, or null before the migration has started. */
export function recordedMigrationState(): MigrationState | null {
  return g.__rev4aBackupsMigration ?? null;
}
