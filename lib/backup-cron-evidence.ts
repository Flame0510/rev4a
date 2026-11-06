/** Read only the exact local pre-update archive; never inspect a live agent or legacy volume. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKUPS_DIR } from '@/lib/rev4a-paths';
import { isValidBackupFile, parseBackupName } from '@/lib/backups';
import { inspectBackupArchive, type BackupInspection } from '@/lib/backup-inspection';
import { verifiedBackupSchemasFor } from '@/lib/backup-compatibility';
import { hasKnownCronRetirement, parseCronJobIdentities, readUpdateBaseline, type PreUpdateCronEvidenceReader } from '@/lib/agent-update-cron';

export function createPreUpdateCronEvidenceReader(options: {
  backupsDir: string;
  inspect?: (file: string) => Promise<BackupInspection>;
}): PreUpdateCronEvidenceReader {
  return async (input) => {
    const unavailable = (reason: string) => ({ kind: 'unavailable' as const, reason });
    if (!hasKnownCronRetirement(input) || !isValidBackupFile(input.agentId, input.backupFile)
      || !readUpdateBaseline(input.baselineJson)) {
      return unavailable('The stored update does not identify a supported pre-update ownership audit');
    }
    const name = parseBackupName(input.backupFile);
    if (name?.kind !== 'preupdate' || name.label !== input.fromVersion) {
      return unavailable('The archive is not the exact source-version pre-update backup recorded by the update');
    }
    const file = path.join(options.backupsDir, input.backupFile);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) return unavailable('The pre-update archive must be a regular file in the backups folder');
    } catch {
      return unavailable('The pre-update archive is not in the backups folder; let legacy backup migration finish or recover the matching archive');
    }
    try {
      const archive = await (options.inspect ?? inspectBackupArchive)(file);
      const expected = verifiedBackupSchemasFor(input.fromVersion);
      if (!expected || archive.configVersion !== input.fromVersion || archive.stateSchemaVersion !== expected.state
        || Object.values(archive.agentSchemaVersions).some((version) => version !== expected.agent)) {
        return unavailable('The archived configuration and database schemas do not prove the recorded source version');
      }
      const jobs = parseCronJobIdentities(archive.cronJobs);
      if (!archive.cronEvidenceComplete || !jobs || !/^[a-f0-9]{64}$/i.test(archive.sha256)) {
        return unavailable('The archive does not contain a complete readable native cron ownership inventory');
      }
      return { kind: 'verified', file: input.backupFile, sha256: archive.sha256, jobs };
    } catch {
      // Inspection can encounter credentials or private paths. Its raw error never enters the audit.
      return unavailable('The pre-update archive could not be safely inspected; the original failure and rollback remain available');
    }
  };
}

export const readPreUpdateCronEvidence = createPreUpdateCronEvidenceReader({ backupsDir: BACKUPS_DIR });
