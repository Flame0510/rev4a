/**
 * Agent backups as plain files in Rev4a's data directory (`<REV4A_DATA>/backups`).
 *
 * Listing, size/mtime, existence and deletion are plain `fs` calls: no helper container to
 * look at a file. Containers are used only to write an archive (it reads an agent volume)
 * and to restore one. Names are validated; a path never comes from a request, and symbolic
 * links are neither listed nor followed (`lstat`, `Dirent.isFile()`).
 *
 * Backups written by older releases live in the Docker volume `rev4a-backups` until
 * lib/backups-migration.ts has moved them; lib/backups-volume.ts reads that side.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BACKUPS_DIR } from '@/lib/rev4a-paths';
import { agentIdOfBackupName, backupBelongsTo, parseBackupName } from '@/lib/backups-names';
export { agentIdOfBackupName, backupBelongsTo, parseBackupName };

/**
 * Which Docker volume is the legacy one. Unset: the default `rev4a-backups`. Set and valid: that name (a
 * test instance must never migrate the real volume into its own data dir). Set but invalid: null, the
 * legacy side is disabled. It must fail closed: falling back to the real volume is what the override exists
 * to prevent.
 */
export function resolveLegacyVolume(override: string | undefined): string | null {
  const v = (override ?? '').trim();
  if (v === '') return 'rev4a-backups';
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v) ? v : null;
}

const LEGACY_VOLUME = resolveLegacyVolume(process.env.REV4A_LEGACY_BACKUP_VOLUME);
/** The legacy volume name. When the legacy side is disabled this is an unusable name; check LEGACY_VOLUME_ENABLED. */
export const BACKUP_VOLUME = LEGACY_VOLUME ?? '';
/** False when REV4A_LEGACY_BACKUP_VOLUME is set to an invalid name: no migration, no volume lookups. */
export const LEGACY_VOLUME_ENABLED = LEGACY_VOLUME !== null;
if (!LEGACY_VOLUME_ENABLED) {
  console.warn('[rev4a] REV4A_LEGACY_BACKUP_VOLUME is not a valid Docker volume name: the legacy backups volume is ignored (no migration, no lookups)');
}

const ARCHIVE_RE = /^[A-Za-z0-9._-]+\.tar\.gz$/;
/** A temporary name in the backups directory: an unfinished write or an unfinished migration copy. */
const TEMP_RE = /^[A-Za-z0-9._-]+\.tar\.gz\.(partial|migrating)$/;

export interface BackupEntry {
  name: string;
  sizeBytes: number;
  /** Modification time, seconds since the epoch. */
  epoch: number;
  location: 'dir' | 'volume';
}

/** The archive is one of this agent's (parsed id, not a prefix: `foo` never takes `foo-bar`); nothing that could carry a path or shell syntax. */
export function isValidBackupFile(agentId: string, file: string): boolean {
  return typeof file === 'string'
    && file.length <= 255
    && !file.includes('..')
    && ARCHIVE_RE.test(file)
    && backupBelongsTo(agentId, file);
}

/** A finished archive name of any agent (the migration works across agents). */
export function isArchiveName(file: string): boolean {
  return typeof file === 'string' && file.length <= 255 && !file.includes('..') && file.startsWith('agent-') && ARCHIVE_RE.test(file);
}

/** A temporary file this module may remove: `<archive>.partial` or `<archive>.migrating`. */
export function isTempName(file: string): boolean {
  return typeof file === 'string' && file.length <= 300 && !file.includes('..') && file.startsWith('agent-') && TEMP_RE.test(file);
}

/** Directory entries of one agent: regular files only (a symlink is skipped), newest first. */
export function listDirBackups(agentId: string, dir: string = BACKUPS_DIR): BackupEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: BackupEntry[] = [];
  for (const name of names) {
    if (!isValidBackupFile(agentId, name)) continue;
    const st = lstatFile(path.join(dir, name));
    if (st) out.push({ name, sizeBytes: st.size, epoch: Math.floor(st.mtimeMs / 1000), location: 'dir' });
  }
  return out.sort((a, b) => b.epoch - a.epoch || a.name.localeCompare(b.name));
}

/** Every finished archive in the directory, any agent (for the migration planner). */
export function listDirArchives(dir: string = BACKUPS_DIR): { name: string; sizeBytes: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: { name: string; sizeBytes: number }[] = [];
  for (const name of names) {
    if (!isArchiveName(name) && !isTempName(name)) continue;
    const st = lstatFile(path.join(dir, name));
    if (st) out.push({ name, sizeBytes: st.size });
  }
  return out;
}

function lstatFile(p: string): fs.Stats | null {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** Whether a regular file of that name is in the directory. */
export function dirHasBackup(file: string, dir: string = BACKUPS_DIR): boolean {
  if (!isArchiveName(file)) return false;
  return lstatFile(path.join(dir, file)) !== null;
}

/**
 * One listing out of the directory and the legacy volume, deduplicated by name; the
 * directory wins. Newest first.
 */
export function mergeBackupListings(dirList: BackupEntry[], volumeList: BackupEntry[]): BackupEntry[] {
  const seen = new Set(dirList.map((b) => b.name));
  const merged = [...dirList, ...volumeList.filter((b) => !seen.has(b.name))];
  return merged.sort((a, b) => b.epoch - a.epoch || a.name.localeCompare(b.name));
}

/** The names to prune: older than the newest `keep` of an agent's archives whose name carries `kindMarker`. */
export function staleByKind(entries: BackupEntry[], agentId: string, kindMarker: string, keep: number): string[] {
  return entries
    .filter((b) => { const p = parseBackupName(b.name); return p?.agentId === agentId && p.kind === kindMarker; })
    .sort((a, b) => b.epoch - a.epoch || b.name.localeCompare(a.name))
    .slice(keep)
    .map((b) => b.name);
}

export type RemoveResult = 'removed' | 'missing' | 'denied';

/**
 * Remove one file of the directory with `fs`. A file that is not a regular file (a symlink,
 * a directory) is left alone. `denied` means fs may not delete it (a root-owned file an older
 * helper wrote): the caller falls back to one helper container.
 */
export function removeDirFile(file: string, dir: string = BACKUPS_DIR): RemoveResult {
  if (!isArchiveName(file) && !isTempName(file)) throw new Error('Invalid backup file name');
  const p = path.join(dir, file);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'denied';
  }
  if (!st.isFile()) return 'denied';
  try {
    fs.unlinkSync(p);
    return 'removed';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'missing';
    return 'denied';
  }
}

/** Every archive of one agent in the directory, for the agent's deletion. */
export function removeAgentDirBackups(agentId: string, dir: string = BACKUPS_DIR): { removed: string[]; denied: string[] } {
  const removed: string[] = [];
  const denied: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed, denied };
  }
  for (const name of names) {
    if (!(isArchiveName(name) || isTempName(name)) || agentIdOfBackupName(name) !== agentId) continue;
    const r = removeDirFile(name, dir);
    if (r === 'removed') removed.push(name);
    else if (r === 'denied') denied.push(name);
  }
  return { removed, denied };
}

/** `uid:gid` of this process for the helper's chown, or null where there is none (Windows). */
export function processOwner(): string | null {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return null;
  return `${process.getuid()}:${process.getgid()}`;
}

/** Free bytes on the filesystem of a directory, or null when it cannot be read. */
export function freeBytes(dir: string = BACKUPS_DIR): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
