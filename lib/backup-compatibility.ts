/** Restore compatibility uses archive contents and verified runtime ceilings, never its filename. */
import type { BackupInspection } from './backup-inspection';

const CEILINGS: Record<string, { state: number; agent: number }> = {
  '2026.9.3': { state: 16, agent: 19 },
  '2026.9.9': { state: 19, agent: 24 },
  '2026.10.10': { state: 22, agent: 27 },
};
/** A copy keeps callers from mutating the shared verified policy. Unknown releases stay unknown. */
export function verifiedBackupSchemasFor(version: string | null): { state: number; agent: number } | null {
  const value = version && Object.hasOwn(CEILINGS, version) ? CEILINGS[version] : undefined;
  return value ? { ...value } : null;
}
export interface BackupCompatibility {
  compatible: boolean;
  sourceVersion: string | null;
  reason: string | null;
}
const parts = (value: string): number[] => value.split(/[.-]/).map(Number);
function newer(a: string, b: string): boolean {
  const left = parts(a); const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta > 0;
  }
  return false;
}

export function checkBackupCompatibility(archive: BackupInspection, targetVersion: string | null): BackupCompatibility {
  const refuse = (reason: string): BackupCompatibility => ({ compatible: false, sourceVersion: archive.configVersion, reason });
  const target = verifiedBackupSchemasFor(targetVersion);
  if (!target) return refuse('The installed OpenClaw version has no verified restore schema limits. Use a verified image or update Rev4a before restoring.');
  if (archive.configVersion && newer(archive.configVersion, targetVersion!)) {
    return refuse(`This backup was written by OpenClaw ${archive.configVersion}, newer than ${targetVersion}. Restore it on that version or newer; use a matching pre-update backup to go back.`);
  }
  if ((archive.stateSchemaVersion !== null && archive.stateSchemaVersion > target.state) || Object.values(archive.agentSchemaVersions).some((schema) => schema > target.agent)) {
    return refuse(`The backup database schema is newer than OpenClaw ${targetVersion} supports. Use the matching pre-update backup or a compatible newer image.`);
  }
  if (archive.configVersion) return { compatible: true, sourceVersion: archive.configVersion, reason: null };

  // Legacy archives need no newly invented manifest: recognized actual core
  // schema generations provide a bounded upward-migration path. Unknown or
  // absent facts never authorize overwriting an existing volume.
  const generations: string[] = [];
  if (archive.stateSchemaVersion !== null) {
    const match = Object.entries(CEILINGS).find(([, ceiling]) => ceiling.state === archive.stateSchemaVersion)?.[0];
    if (!match) return refuse('This legacy backup has an unrecognized state schema. Inspect or migrate a copy with its original OpenClaw version before restoring.');
    generations.push(match);
  }
  for (const schema of Object.values(archive.agentSchemaVersions)) {
    const match = Object.entries(CEILINGS).find(([, ceiling]) => ceiling.agent === schema)?.[0];
    if (!match) return refuse('This legacy backup has an unrecognized agent schema. Inspect or migrate a copy with its original OpenClaw version before restoring.');
    generations.push(match);
  }
  if (!generations.length) return refuse('This legacy backup has neither version metadata nor recognized database schemas. Inspect a copy with its original OpenClaw version before restoring.');
  const sourceVersion = generations.reduce((latest, value) => newer(value, latest) ? value : latest);
  return { compatible: true, sourceVersion, reason: null };
}
