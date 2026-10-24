/**
 * The one parser for an agent backup file name. Pure: no fs, no Docker.
 *
 * Names are written by lib/cold-backup.ts:
 *   agent-<id>-cold-<timestamp>.tar.gz
 *   agent-<id>-prerecreate-<timestamp>.tar.gz
 *   agent-<id>-preupdate-<label>-<timestamp>.tar.gz
 * and, by releases before the kinds existed, `agent-<id>-<timestamp>.tar.gz`.
 * The timestamp is `YYYY-MM-DD_HHMM` (old) or `YYYY-MM-DD_HHMMSSmmm`.
 *
 * An agent id may contain `-` (AGENT_ID_REGEX in lib/container.ts), so `agent-foo-` is also the
 * start of `agent-foo-bar-cold-…`. Selecting an agent's files by prefix would take another agent's
 * files. The name is therefore anchored from the right (timestamp, then the kind) and the id is
 * what is left in front; every place that picks an agent's backups compares the parsed id.
 */

export type BackupKind = 'cold' | 'prerecreate' | 'preupdate' | 'dated';

export interface ParsedBackupName {
  agentId: string;
  kind: BackupKind;
  /** The OpenClaw version of a pre-update archive; null for the other kinds. */
  label: string | null;
  timestamp: string;
}

const TS = '\\d{4}-\\d{2}-\\d{2}_\\d{4,9}';
// `(.+)` is greedy: the id is the longest prefix that leaves a valid kind and timestamp, so an id that
// itself contains `-cold-` or `-preupdate-` is still read whole.
const KINDED_RE = new RegExp(`^agent-(.+)-(?:(cold|prerecreate)|preupdate-([A-Za-z0-9._-]+))-(${TS})\\.tar\\.gz$`);
const DATED_RE = new RegExp(`^agent-(.+)-(${TS})\\.tar\\.gz$`);

/** The id, kind and timestamp of an archive name, or null when it is not a name Rev4a writes. */
export function parseBackupName(name: string): ParsedBackupName | null {
  if (typeof name !== 'string' || name.length > 255 || name.includes('..')) return null;
  const m = KINDED_RE.exec(name);
  if (m) {
    return m[2]
      ? { agentId: m[1], kind: m[2] as BackupKind, label: null, timestamp: m[4] }
      : { agentId: m[1], kind: 'preupdate', label: m[3], timestamp: m[4] };
  }
  const d = DATED_RE.exec(name);
  return d ? { agentId: d[1], kind: 'dated', label: null, timestamp: d[2] } : null;
}

/** Whether the archive name belongs to exactly this agent (never to an agent whose id extends it). */
export function backupBelongsTo(agentId: string, name: string): boolean {
  return parseBackupName(name)?.agentId === agentId;
}

/** The agent id in an archive (or `.partial` / `.migrating` temporary) name, or null. */
export function agentIdOfBackupName(name: string): string | null {
  return parseBackupName(name.replace(/\.(partial|migrating)$/, ''))?.agentId ?? null;
}
