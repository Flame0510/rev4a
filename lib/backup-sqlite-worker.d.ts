export interface BackupDatabaseFacts {
  stateSchemaVersion: number | null;
  agentSchemaVersions: Record<string, number>;
  cronJobs: { id: string; name: string | null; declarationKey: string | null; agentId: string | null }[];
  cronEvidenceComplete: boolean;
}
export function inspectBackupDatabases(files: { member: string; file: string }[], timeoutMs: number): Promise<BackupDatabaseFacts>;
