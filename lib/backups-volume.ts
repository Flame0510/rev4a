/**
 * Backups across the host directory and the legacy Docker volume `rev4a-backups`.
 *
 * Until lib/backups-migration.ts has moved everything, a backup can be in either place:
 * every listing, existence check, delete and prune here looks in both (the directory wins on
 * a name that is in both). The volume is only ever touched when it exists — a `docker run -v
 * rev4a-backups:…` would create it again. Once it is gone these functions are `fs` only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dockerFetch } from '@/lib/docker-socket';
import { runDocker } from '@/lib/agent-images';
import { BACKUPS_DIR } from '@/lib/rev4a-paths';
import {
  BACKUP_VOLUME,
  LEGACY_VOLUME_ENABLED,
  dirHasBackup,
  isArchiveName,
  isValidBackupFile,
  listDirBackups,
  mergeBackupListings,
  processOwner,
  removeAgentDirBackups,
  removeDirFile,
  staleByKind,
  type BackupEntry,
} from '@/lib/backups';

export { BACKUP_VOLUME };

/** Whether an error from dockerFetch is Docker's "no such volume" (the request helper rejects on status >= 400). */
export function isDockerNotFound(e: unknown): boolean {
  return /^Docker error 404\b/.test(String((e as Error)?.message ?? ''));
}

/**
 * Whether the legacy volume exists. False when it does not exist (Docker answers 404) or the legacy side is
 * disabled; null only when Docker really cannot answer. Callers must not read null as "absent".
 */
export async function legacyVolumeExists(): Promise<boolean | null> {
  if (!LEGACY_VOLUME_ENABLED) return false;
  try {
    const info = await dockerFetch<{ Name?: string }>('GET', `/volumes/${BACKUP_VOLUME}`);
    return info?.Name === BACKUP_VOLUME;
  } catch (e) {
    return isDockerNotFound(e) ? false : null;
  }
}

/** The volume's existence, or a thrown error when Docker cannot answer (never "absent" by default). */
async function legacyVolumeExistsOrThrow(): Promise<boolean> {
  const exists = await legacyVolumeExists();
  if (exists === null) throw new Error('Docker did not answer: the legacy backups volume could not be checked');
  return exists;
}

/** Archives of one agent in the legacy volume (empty when the volume is gone). Throws when the listing fails. */
export async function listVolumeBackups(agentId: string): Promise<BackupEntry[]> {
  if (!(await legacyVolumeExistsOrThrow())) return [];
  const prefix = `agent-${agentId}-`;
  const lines: string[] = [];
  await runDocker(
    // $PREFIX stays unquoted so the shell expands the glob; the id is validated, so the
    // pattern carries no shell metacharacters.
    ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup:ro`, 'alpine', 'sh', '-c',
      'stat -c "%s %Y %n" /backup/$PREFIX*.tar.gz 2>/dev/null || true'],
    { timeoutMs: 30_000, env: { PREFIX: prefix }, onLine: (line) => lines.push(line.trim()) },
  );
  const out: BackupEntry[] = [];
  for (const line of lines) {
    // busybox `stat -c "%s %Y %n"`: 12345 1711234567 /backup/agent-x-2026-07-11_2151.tar.gz
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const name = parts.slice(2).join(' ').replace(/^\/backup\//, '');
    if (!isValidBackupFile(agentId, name)) continue;
    out.push({ name, sizeBytes: parseInt(parts[0], 10) || 0, epoch: parseInt(parts[1], 10) || 0, location: 'volume' });
  }
  return out;
}

/** The agent's backups from both places, newest first. Throws when the volume exists but cannot be listed. */
export async function listAgentBackups(agentId: string, dir: string = BACKUPS_DIR): Promise<BackupEntry[]> {
  return mergeBackupListings(listDirBackups(agentId, dir), await listVolumeBackups(agentId));
}

/**
 * Where the archive is: the directory (fs) or the legacy volume (one helper container, only
 * while the volume exists), null when it is nowhere. Throws when the volume exists and Docker
 * cannot answer, so a Docker failure never reads as "deleted".
 */
export async function locateBackup(file: string, dir: string = BACKUPS_DIR): Promise<'dir' | 'volume' | null> {
  if (!isArchiveName(file)) return null;
  if (dirHasBackup(file, dir)) return 'dir';
  if (!(await legacyVolumeExistsOrThrow())) return null;
  let answer = '';
  await runDocker(
    ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup:ro`, 'alpine', 'sh', '-c',
      'if [ -f "/backup/$FILE" ]; then echo present; else echo absent; fi'],
    { timeoutMs: 60_000, env: { FILE: file }, onLine: (line) => { const t = line.trim(); if (t === 'present' || t === 'absent') answer = t; } },
  );
  if (!answer) throw new Error('The backup check gave no answer');
  return answer === 'present' ? 'volume' : null;
}

/** The `-v` source a helper mounts at /backup to read this archive: the directory or the legacy volume. */
export async function backupMountSource(file: string, dir: string = BACKUPS_DIR): Promise<string | null> {
  const where = await locateBackup(file, dir);
  return where === 'dir' ? dir : where === 'volume' ? BACKUP_VOLUME : null;
}

/** One helper container removes files from the directory that fs may not delete (root-owned, from an older helper). */
async function removeViaHelper(files: string[], dir: string): Promise<void> {
  for (const file of files) {
    await runDocker(
      ['run', '--rm', '-v', `${dir}:/backup`, 'alpine', 'sh', '-c', 'rm -f "/backup/$FILE"'],
      { timeoutMs: 60_000, env: { FILE: file } },
    );
  }
}

/** Removes a volume file; with SIZE set, only when it has that size (a same-name file of another size is a conflict copy and stays). */
const VOLUME_RM_SCRIPT = [
  '[ -f "/backup/$FILE" ] || exit 0',
  'if [ -n "${SIZE:-}" ] && [ "$(stat -c %s "/backup/$FILE")" != "$SIZE" ]; then echo "kept: another size"; exit 0; fi',
  'rm -f "/backup/$FILE"',
].join('\n');

/**
 * Remove an archive from the directory (fs, helper fallback) and from the legacy volume when it is there.
 * Throws, before deleting anything, when Docker cannot say whether the volume exists. A volume file with the
 * same name as a directory file but another size is a conflict copy of the migration and is left alone.
 */
export async function deleteBackupFile(file: string, dir: string = BACKUPS_DIR): Promise<void> {
  if (!isArchiveName(file)) throw new Error('Invalid backup file name');
  const volume = await legacyVolumeExistsOrThrow();
  let dirSize: number | null = null;
  try {
    const st = fs.lstatSync(path.join(dir, file));
    if (st.isFile()) dirSize = st.size;
  } catch { /* not in the directory */ }
  if (removeDirFile(file, dir) === 'denied') await removeViaHelper([file], dir);
  if (volume) {
    await runDocker(
      ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, 'alpine', 'sh', '-c', VOLUME_RM_SCRIPT],
      { timeoutMs: 60_000, env: { FILE: file, ...(dirSize !== null ? { SIZE: String(dirSize) } : {}) } },
    );
  }
}

/** Remove every archive of a deleted agent from both places. Best-effort: returns what could not be removed. */
export async function deleteAgentBackups(agentId: string, dir: string = BACKUPS_DIR): Promise<string[]> {
  const failed: string[] = [];
  const { denied } = removeAgentDirBackups(agentId, dir);
  if (denied.length) {
    await removeViaHelper(denied, dir).catch((e) => failed.push(...denied.map((n) => `${n}: ${(e as Error).message}`)));
  }
  try {
    if (await legacyVolumeExistsOrThrow()) {
      const names = (await listVolumeBackups(agentId)).map((b) => b.name);
      for (const name of names) {
        await runDocker(
          ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, 'alpine', 'sh', '-c', 'rm -f "/backup/$FILE"'],
          { timeoutMs: 60_000, env: { FILE: name } },
        );
      }
    }
  } catch (e) {
    failed.push((e as Error).message);
  }
  return failed;
}

/** Delete the agent's archives of one kind older than the newest `keep`; returns the names removed. */
export async function pruneBackups(agentId: string, kindMarker: string, keep: number, dir: string = BACKUPS_DIR): Promise<string[]> {
  let entries: BackupEntry[];
  try {
    entries = await listAgentBackups(agentId, dir);
  } catch {
    entries = listDirBackups(agentId, dir);
  }
  const stale = staleByKind(entries, agentId, kindMarker, keep);
  const removed: string[] = [];
  for (const file of stale) {
    try {
      await deleteBackupFile(file, dir);
      removed.push(file);
    } catch {
      // keep going; the next recreate prunes it again
    }
  }
  return removed;
}

/** Environment for the writing helper: the owner its archive is given, so Rev4a can list and delete it. */
export function helperOwnerEnv(): string[] {
  const owner = processOwner();
  return owner ? ['-e', `OWNER=${owner}`] : [];
}
