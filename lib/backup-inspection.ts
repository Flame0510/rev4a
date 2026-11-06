/** Bounded host-only archive inspection. Never extracts arbitrary paths or returns personal rows. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { inspectBackupDatabases } from './backup-sqlite-worker.js';

export interface BackupInspection {
  sha256: string;
  configVersion: string | null;
  stateSchemaVersion: number | null;
  agentSchemaVersions: Record<string, number>;
  cronJobs: { id: string; name: string | null; declarationKey: string | null; agentId: string | null }[];
  cronEvidenceComplete: boolean;
}
export interface BackupInspectionLimits {
  maxArchiveBytes?: number;
  maxExpandedBytes?: number;
  maxSelectedBytes?: number;
  maxMemberBytes?: number;
  maxMembers?: number;
  timeoutMs?: number;
}
export class BackupInspectionError extends Error {}
const CONFIG = '.openclaw/openclaw.json';
const STATE = '.openclaw/state/openclaw.sqlite';
const AGENT_DB = /^\.openclaw\/agents\/([a-zA-Z0-9_-]+)\/agent\/openclaw-agent\.sqlite$/;
function fail(reason: string): never { throw new BackupInspectionError(reason); }

function tarString(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul < 0 ? undefined : nul).toString('utf8');
}
function tarNumber(bytes: Buffer): number {
  let value: bigint;
  if (bytes[0] & 0x80) {
    if (bytes[0] & 0x40) fail('Archive has a negative member size');
    value = BigInt(bytes[0] & 0x7f);
    for (const byte of bytes.subarray(1)) value = (value << 8n) + BigInt(byte);
  } else {
    const text = tarString(bytes).trim();
    if (!/^[0-7]*$/.test(text)) fail('Archive has an invalid numeric header');
    value = text ? BigInt(`0o${text}`) : 0n;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('Archive member size exceeds the inspection budget');
  return Number(value);
}
function safeMember(raw: string, directory = false): string {
  if (!raw || raw.startsWith('/') || /[\0\r\n\\]/.test(raw)) fail('Archive contains an unsafe member path');
  const parts = raw.split('/');
  if (parts.includes('..')) fail('Archive contains a parent traversal');
  const normalized = parts.filter((part) => part && part !== '.').join('/');
  if (!normalized && !directory) fail('Archive has an empty member path');
  return normalized;
}
function parsePax(bytes: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at);
    if (space < 0 || !/^\d+$/.test(bytes.subarray(at, space).toString())) fail('Archive has malformed PAX metadata');
    const length = Number(bytes.subarray(at, space).toString());
    if (!Number.isSafeInteger(length) || length <= space - at + 2 || at + length > bytes.length || bytes[at + length - 1] !== 10) fail('Archive has truncated PAX metadata');
    const record = bytes.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 1) fail('Archive has malformed PAX metadata');
    const key = record.slice(0, equals);
    if (Object.hasOwn(out, key)) fail('Archive has duplicate PAX keys');
    if (!['path', 'linkpath', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'hdrcharset', 'LIBARCHIVE.creationtime'].includes(key)) {
      fail('Archive uses unsupported PAX metadata; create a standard non-sparse backup');
    }
    out[key] = record.slice(equals + 1);
    at += length;
  }
  return out;
}

/**
 * Reads the full gzip/tar stream, validates every header/path and only copies config
 * and canonical SQLite(+WAL) members to generated files in a private directory.
 * Links are never materialized; entries beneath a link are rejected in either order.
 */
export async function inspectBackupArchive(archivePath: string, options: BackupInspectionLimits = {}): Promise<BackupInspection> {
  const startedAt = Date.now();
  const limits = {
    maxArchiveBytes: options.maxArchiveBytes ?? 32 * 1024 ** 3,
    maxExpandedBytes: options.maxExpandedBytes ?? 64 * 1024 ** 3,
    maxSelectedBytes: options.maxSelectedBytes ?? 2 * 1024 ** 3,
    maxMemberBytes: options.maxMemberBytes ?? 16 * 1024 ** 3,
    maxMembers: options.maxMembers ?? 1_000_000,
    timeoutMs: options.timeoutMs ?? 180_000,
  };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) fail('Invalid archive inspection budget');
  const fd = await fsp.open(archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => fail('Backup must be a readable local regular file'));
  const before = await fd.stat();
  if (!before.isFile() || before.size < 1 || before.size > limits.maxArchiveBytes) { await fd.close(); fail('Backup is not a regular file within the inspection budget'); }
  // Stay on the archive's disk: /tmp may be a small tmpfs, while SQLite members can be large.
  const temp = await fsp.mkdtemp(path.join(path.dirname(archivePath), '.rev4a-backup-inspect-')).catch(async () => {
    await fd.close();
    return fail('A private inspection directory could not be created beside the backup');
  });
  await fsp.chmod(temp, 0o700).catch(async () => {
    await fd.close(); await fsp.rm(temp, { recursive: true, force: true });
    return fail('The private inspection directory could not be secured');
  });
  const source = fd.createReadStream({ autoClose: false, start: 0, end: before.size - 1 });
  const gunzip = createGunzip();
  const hash = createHash('sha256');
  source.on('data', (chunk) => hash.update(chunk));
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const timer = setTimeout(() => gunzip.destroy(new BackupInspectionError('Backup inspection timed out; retry on a host with sufficient resources')), limits.timeoutMs);
  const selected = new Map<string, string>();
  const members = new Map<string, string>();
  const links = new Set<string>();
  let file: fsp.FileHandle | null = null;
  let pending: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let expanded = 0;
  let selectedBytes = 0;
  let count = 0;
  let zeros = 0;
  let metadata: Buffer[] | null = null;
  let metadataType = '';
  let pax: Record<string, string> | null = null;
  let longName: string | null = null;
  let longLink: string | null = null;
  try {
    for await (const part of gunzip) {
      const chunk = part as Buffer;
      expanded += chunk.length;
      if (expanded > limits.maxExpandedBytes) fail('Backup expansion exceeds the inspection budget');
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        if (remaining) {
          const size = Math.min(remaining, pending.length);
          const body = pending.subarray(0, size);
          if (file) await file.writeFile(body);
          if (metadata) metadata.push(Buffer.from(body));
          remaining -= size;
          pending = pending.subarray(size);
          if (!remaining) {
            if (file) { await file.close(); file = null; }
            if (metadata) {
              const value = Buffer.concat(metadata);
              if (metadataType === 'x') pax = parsePax(value);
              else if (metadataType === 'g') {
                const global = parsePax(value);
                if (['path', 'linkpath', 'size'].some((key) => key in global)) fail('Archive has unsafe global PAX overrides');
              } else if (metadataType === 'L') longName = tarString(value).replace(/\n$/, '');
              else longLink = tarString(value).replace(/\n$/, '');
              metadata = null;
            }
          }
          continue;
        }
        if (padding) {
          const size = Math.min(padding, pending.length);
          if (pending.subarray(0, size).some((byte) => byte !== 0)) fail('Archive has invalid member padding');
          pending = pending.subarray(size); padding -= size;
          continue;
        }
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512); pending = pending.subarray(512);
        if (header.every((byte) => byte === 0)) { zeros++; continue; }
        if (zeros) fail('Archive has data after its end marker');
        if (++count > limits.maxMembers) fail('Archive has too many members');
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
        if (checksum !== tarNumber(header.subarray(148, 156))) fail('Archive has an invalid header checksum');
        const type = String.fromCharCode(header[156] || 48);
        const headerSize = tarNumber(header.subarray(124, 136));
        if (headerSize > limits.maxMemberBytes) fail('Archive member exceeds the inspection budget');
        if (['x', 'g', 'L', 'K'].includes(type)) {
          if (headerSize < 1 || headerSize > 64 * 1024) fail('Archive metadata exceeds the inspection budget');
          if ((type === 'x' && pax) || (type === 'L' && longName) || (type === 'K' && longLink)) fail('Archive has conflicting member metadata');
          metadata = []; metadataType = type;
          remaining = headerSize; padding = (512 - remaining % 512) % 512;
          continue;
        }
        const prefix = header.subarray(257, 263).equals(Buffer.from('ustar\0')) ? tarString(header.subarray(345, 500)) : '';
        if ((pax?.path !== undefined && longName !== null) || (pax?.linkpath !== undefined && longLink !== null)) fail('Archive has conflicting path metadata');
        const rawName = pax?.path ?? longName ?? [prefix, tarString(header.subarray(0, 100))].filter(Boolean).join('/');
        const name = safeMember(rawName, type === '5');
        const sizeText = pax?.size;
        const size = sizeText === undefined ? headerSize : /^\d+$/.test(sizeText) ? Number(sizeText) : NaN;
        if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxMemberBytes) fail('Archive has an invalid PAX size');
        const link = pax?.linkpath ?? longLink ?? tarString(header.subarray(157, 257));
        pax = null; longName = null; longLink = null;
        if (members.has(name)) fail('Archive contains duplicate normalized members');
        members.set(name, type);
        if (!['0', '1', '2', '5'].includes(type)) fail('Archive contains unsupported special or sparse members');
        if (type !== '0' && size !== 0) fail('Archive has a non-file member with data');
        if (type === '1' || type === '2') {
          links.add(name);
          if (type === '1') safeMember(link);
        }
        const base = name.endsWith('-wal') ? name.slice(0, -4) : name;
        const capture = name === CONFIG || base === STATE || AGENT_DB.test(base);
        if (capture) {
          if (type !== '0') fail('Backup config and databases must be regular members');
          if (size > (name === CONFIG ? 1024 ** 2 : 512 * 1024 ** 2) || (selectedBytes += size) > limits.maxSelectedBytes) fail('Selected backup data exceeds the inspection budget');
          const baseName = selected.get(base) ?? path.join(temp, `member-${selected.size}`);
          const target = name.endsWith('-wal') ? `${baseName}-wal` : baseName;
          // Reserve the canonical base path even if WAL appears first.
          if (name.endsWith('-wal') && !selected.has(base)) selected.set(base, baseName);
          selected.set(name, target);
          file = await fsp.open(target, 'wx', 0o600);
          if (!size) { await file.close(); file = null; }
        }
        remaining = size; padding = (512 - size % 512) % 512;
      }
    }
    if (remaining || padding || metadata || pending.length || zeros < 2 || pax || longName || longLink) fail('Backup tar stream is truncated or missing its end marker');
    for (const name of members.keys()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        if (links.has(parent)) fail('Archive contains members beneath a link');
        if (members.has(parent) && members.get(parent) !== '5') fail('Archive contains members beneath a non-directory');
      }
    }
    const after = await fd.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail('Backup changed during inspection; retry with a completed archive');
    const configFile = selected.get(CONFIG);
    if (!configFile) fail('Backup has no canonical OpenClaw configuration');
    let config: { meta?: { lastTouchedVersion?: unknown } };
    try { config = JSON.parse(await fsp.readFile(configFile, 'utf8')); }
    catch { fail('Backup configuration is not valid JSON'); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail('Backup configuration has an invalid shape');
    const version = config.meta?.lastTouchedVersion;
    const result: BackupInspection = {
      sha256: hash.digest('hex'),
      configVersion: typeof version === 'string' && /^\d{4}\.\d+\.\d+(?:-\d+)?$/.test(version) ? version : null,
      stateSchemaVersion: null, agentSchemaVersions: {}, cronJobs: [], cronEvidenceComplete: false,
    };
    const databases: { member: string; file: string }[] = [];
    for (const [member, fileName] of selected) {
      if (member === CONFIG || member.endsWith('-wal')) continue;
      if (!members.has(member)) fail('Backup has a WAL file without its database');
      databases.push({ member, file: fileName });
    }
    if (databases.length) {
      const remainingMs = limits.timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) fail('Backup inspection timed out');
      try { Object.assign(result, await inspectBackupDatabases(databases, remainingMs)); }
      catch { fail('Backup SQLite/WAL integrity could not be verified within the inspection budget'); }
    }
    return result;
  } catch (error) {
    if (error instanceof BackupInspectionError) throw error;
    fail('Backup gzip/tar stream could not be read completely');
  } finally {
    clearTimeout(timer); source.destroy(); gunzip.destroy();
    await file?.close().catch(() => {});
    await fd.close().catch(() => {});
    await fsp.rm(temp, { recursive: true, force: true });
  }
  return fail('Backup inspection did not complete');
}
