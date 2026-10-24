/**
 * The real dependencies of the backups migration (Docker, the backups directory, the agent
 * busy checks), the startup entry point and the status read. The logic is in
 * lib/backups-migration.ts.
 */
import { dockerFetch } from '@/lib/docker-socket';
import { runDocker } from '@/lib/agent-images';
import { agentBusyReason } from '@/lib/agent-busy';
import { isValidAgentId } from '@/lib/container';
import { BACKUPS_DIR, ensureBackupsDir } from '@/lib/rev4a-paths';
import { BACKUP_VOLUME, freeBytes, isArchiveName, isTempName, listDirArchives, processOwner, removeDirFile } from '@/lib/backups';
import { legacyVolumeExists } from '@/lib/backups-volume';
import {
  agentIdOfBackup,
  CopyVerificationError,
  DOCKER_SILENT_REASON,
  recordedMigrationState,
  recordMigrationState,
  runMigration,
  type FileSize,
  type MigrationDeps,
  type MigrationState,
} from '@/lib/backups-migration';

/** The helper copies, verifies and hands over one file. Runs as root; `OWNER` gives the file to Rev4a's user. */
const COPY_SCRIPT = [
  'set -eu',
  'S="/old/$FILE"; D="/new/$FILE"; T="$D.migrating"',
  '[ -f "$S" ] || { echo "source missing" >&2; exit 2; }',
  'SIZE=$(stat -c %s "$S")',
  // A leftover temporary copy is removed before the space is measured, so it cannot block its own redo.
  'rm -f "$T"',
  'AVAIL=$(( $(df -Pk /new | awk \'NR==2 {print $4}\') * 1024 ))',
  '[ "$AVAIL" -ge "$SIZE" ] || { echo "not enough space: $SIZE bytes needed, $AVAIL free" >&2; exit 3; }',
  'cp -p "$S" "$T" || { rm -f "$T"; exit 4; }',
  'if ! tar -tzf "$T" > /dev/null 2>&1; then rm -f "$T"; echo "REV4A-VERIFY the copy does not read back" >&2; exit 5; fi',
  '[ "$(stat -c %s "$T")" = "$SIZE" ] || { rm -f "$T"; echo "REV4A-VERIFY the copy has another size" >&2; exit 6; }',
  'mv "$T" "$D"',
  'if [ -n "${OWNER:-}" ]; then chown "$OWNER" "$D" || true; fi',
  'chmod 600 "$D"',
].join('\n');

const COPY_TIMEOUT_MS = 60 * 60 * 1000;

function realDeps(): MigrationDeps {
  return {
    volumeExists: legacyVolumeExists,
    async listVolumeArchives(): Promise<FileSize[]> {
      const lines: string[] = [];
      await runDocker(
        ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup:ro`, 'alpine', 'sh', '-c',
          'stat -c "%s %n" /backup/agent-*.tar.gz 2>/dev/null || true'],
        { timeoutMs: 60_000, onLine: (l) => lines.push(l.trim()) },
      );
      const out: FileSize[] = [];
      for (const line of lines) {
        const m = /^(\d+) \/backup\/(.+)$/.exec(line);
        if (m && isArchiveName(m[2])) out.push({ name: m[2], sizeBytes: Number(m[1]) });
      }
      return out;
    },
    listDirFiles: () => listDirArchives(BACKUPS_DIR),
    freeBytes: () => freeBytes(BACKUPS_DIR),
    async isBusy(name: string): Promise<boolean> {
      const id = agentIdOfBackup(name);
      if (!id || !isValidAgentId(id)) return false;
      return (await agentBusyReason(id).catch(() => null)) !== null;
    },
    async copyVerified(name: string): Promise<void> {
      const owner = processOwner();
      try {
        await runDocker(
          ['run', '--rm', '-v', `${BACKUP_VOLUME}:/old:ro`, '-v', `${BACKUPS_DIR}:/new`, 'alpine', 'sh', '-c', COPY_SCRIPT],
          { timeoutMs: COPY_TIMEOUT_MS, env: { FILE: name, ...(owner ? { OWNER: owner } : {}) } },
        );
      } catch (e) {
        // A copy that does not verify is the file's own problem (the migration skips it); anything else stops the run.
        const msg = (e as Error).message;
        if (msg.includes('REV4A-VERIFY')) throw new CopyVerificationError(msg.replace(/^.*?REV4A-VERIFY\s*/, '').replace(/\)$/, ''));
        throw e;
      }
    },
    async removeFromVolume(name: string): Promise<void> {
      await runDocker(
        ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, 'alpine', 'sh', '-c', 'rm -f "/backup/$FILE"'],
        { timeoutMs: 60_000, env: { FILE: name } },
      );
    },
    async listVolumeTemps(): Promise<string[]> {
      const names: string[] = [];
      await runDocker(
        ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup:ro`, 'alpine', 'sh', '-c',
          'ls -1 /backup 2>/dev/null | grep -E "\\.tar\\.gz\\.partial$" || true'],
        { timeoutMs: 60_000, onLine: (l) => { const t = l.trim(); if (isTempName(t)) names.push(t); } },
      );
      return names;
    },
    removeDirFile(name: string): void {
      removeDirFile(name, BACKUPS_DIR);
    },
    async volumeEmpty(): Promise<boolean> {
      let any = false;
      await runDocker(
        ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup:ro`, 'alpine', 'sh', '-c', 'ls -A /backup'],
        { timeoutMs: 60_000, onLine: (l) => { if (l.trim()) any = true; } },
      );
      return !any;
    },
    async volumeInUse(): Promise<boolean> {
      const filters = encodeURIComponent(JSON.stringify({ volume: [BACKUP_VOLUME] }));
      const list = await dockerFetch<unknown[]>('GET', `/containers/json?all=true&filters=${filters}`);
      return Array.isArray(list) && list.length > 0;
    },
    async removeVolume(): Promise<void> {
      await runDocker(['volume', 'rm', BACKUP_VOLUME], { timeoutMs: 30_000 });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(`[rev4a] ${line}`),
  };
}

const g = globalThis as unknown as { __rev4aBackupsMigrationRunning?: boolean; __rev4aBackupsMigrationTimer?: ReturnType<typeof setTimeout> };

/** How long to wait before asking again after "Docker did not answer" (Docker Desktop started after Rev4a). */
const DOCKER_RETRY_LATER_MS = 5 * 60 * 1000;

/**
 * Start the migration in the background (not awaited by the caller). Idempotent: a second call while one
 * runs does nothing, and a finished or empty migration finds nothing to do. When it stopped only because
 * Docker could not be asked, it tries again every 5 minutes until Docker answers; no other stop reason is
 * retried on its own (those need a person, or the next start).
 */
export function startBackupsMigration(): void {
  if (g.__rev4aBackupsMigrationRunning) return;
  g.__rev4aBackupsMigrationRunning = true;
  ensureBackupsDir();
  recordMigrationState({ status: 'pending', reason: null, moved: 0, remaining: 0, current: null, skipped: [] });
  void runMigration(realDeps(), recordMigrationState)
    .then((final) => {
      if (final.status === 'stopped' && final.reason === DOCKER_SILENT_REASON) {
        console.log('[rev4a] Backups migration: Docker did not answer; trying again in 5 minutes');
        g.__rev4aBackupsMigrationTimer = setTimeout(() => {
          g.__rev4aBackupsMigrationTimer = undefined;
          startBackupsMigration();
        }, DOCKER_RETRY_LATER_MS);
        g.__rev4aBackupsMigrationTimer.unref?.();
      }
    })
    .catch((e) => console.warn(`[rev4a] Backups migration failed: ${(e as Error)?.message ?? e}`))
    .finally(() => { g.__rev4aBackupsMigrationRunning = false; });
}

/** For the System page: pending / running / done / stopped(reason). */
export async function backupsMigrationStatus(): Promise<MigrationState> {
  const recorded = recordedMigrationState();
  if (recorded) return recorded;
  const exists = await legacyVolumeExists();
  return { status: exists === false ? 'done' : 'pending', reason: null, moved: 0, remaining: 0, current: null, skipped: [] };
}
