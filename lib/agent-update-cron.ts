/** Pure cron identity, transition and repair rules. No runtime discovery or account selection. */
export interface CronJobIdentity {
  id: string;
  name: string | null;
  declarationKey: string | null;
  agentId: string | null;
}

export interface UpdateBaseline {
  transcripts: Record<string, number>;
  /** Kept for older Rev4a releases which read names only. */
  cronJobs: string[] | null;
  cronBaselineVersion?: 1;
  cronJobIdentities?: CronJobIdentity[] | null;
}

export interface UpdateVerification {
  sessions: number;
  lostEvents: { session: string; before: number; after: number }[];
  missingCronJobs: string[] | null;
  /** Proven upstream-owned retirements, not lost user jobs. */
  retiredCronJobs?: string[];
  ok: boolean;
}

export interface CronTransition { fromVersion: string | null; toVersion: string }

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const optionalText = (value: unknown): value is string | null | undefined => value == null || text(value);

/** Only documented list envelopes and usable identities count as a read, including an empty read. */
export function parseCronJobIdentities(value: unknown): CronJobIdentity[] | null {
  const jobs = Array.isArray(value) ? value : record(value) && Array.isArray(value.jobs) ? value.jobs : null;
  if (!jobs) return null;
  if (record(value)) {
    // A transport error or a partial page is never a complete preservation baseline.
    if (('ok' in value && value.ok !== true) || ('success' in value && value.success !== true)
      || (value.error != null && value.error !== '')
      || ('hasMore' in value && value.hasMore !== false)
      || value.truncated === true || value.partial === true
      || (value.nextOffset != null) || (value.offset != null && value.offset !== 0)) return null;
    for (const key of ['total', 'totalCount']) {
      if (key in value && (!Number.isSafeInteger(value[key]) || value[key] !== jobs.length)) return null;
    }
  }
  const seen = new Set<string>();
  const result: CronJobIdentity[] = [];
  for (const job of jobs) {
    if (!record(job) || !text(job.id) || seen.has(job.id)
      || !optionalText(job.name) || !optionalText(job.declarationKey) || !optionalText(job.agentId)) return null;
    seen.add(job.id);
    result.push({ id: job.id, name: job.name ?? null, declarationKey: job.declarationKey ?? null, agentId: job.agentId ?? null } as CronJobIdentity);
  }
  return result;
}

export function parseCronListForUpdate(raw: string): CronJobIdentity[] | null {
  const start = raw.search(/[{[]/);
  if (start < 0) return null;
  try { return parseCronJobIdentities(JSON.parse(raw.slice(start))); } catch { return null; }
}

export const cronNames = (jobs: CronJobIdentity[]): string[] => jobs.map((job) => job.name ?? job.id).sort();
const sameNames = (a: string[], b: string[]): boolean => {
  const aa = [...a].sort();
  const bb = [...b].sort();
  return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
};

/** Accept old name-only baselines, but never downgrade malformed/unknown rich baselines to names. */
export function parseUpdateBaseline(value: unknown): UpdateBaseline | null {
  if (!record(value) || !record(value.transcripts)
    || !Object.values(value.transcripts).every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
    || !(value.cronJobs === null || Array.isArray(value.cronJobs) && value.cronJobs.every(text))) return null;
  const baseline: UpdateBaseline = { transcripts: value.transcripts as Record<string, number>, cronJobs: value.cronJobs as string[] | null };
  if ('cronBaselineVersion' in value || 'cronJobIdentities' in value) {
    if (value.cronBaselineVersion !== 1) return null;
    const identities = value.cronJobIdentities === null ? null : parseCronJobIdentities(value.cronJobIdentities);
    if (identities === null && value.cronJobIdentities !== null) return null;
    if (identities === null ? baseline.cronJobs !== null : baseline.cronJobs === null || !sameNames(cronNames(identities), baseline.cronJobs)) return null;
    baseline.cronBaselineVersion = 1;
    baseline.cronJobIdentities = identities;
  }
  return baseline;
}

export function readUpdateBaseline(json: string | null): UpdateBaseline | null {
  if (!json) return null;
  try { return parseUpdateBaseline(JSON.parse(json)); } catch { return null; }
}

/** Restrict this exception to the source/target releases actually evaluated in OC-10. */
export function hasKnownCronRetirement(transition: CronTransition): boolean {
  return (transition.fromVersion === '2026.9.3' || transition.fromVersion === '2026.9.9')
    && transition.toVersion === '2026.10.10';
}

export function isRetiredOwnedCron(job: CronJobIdentity, transition?: CronTransition): boolean {
  if (!transition || !hasKnownCronRetirement(transition)) return false;
  const prefix = 'skill-collection-review:';
  if (!job.declarationKey?.startsWith(prefix)) return false;
  const owner = job.declarationKey.slice(prefix.length);
  return text(owner) && (!job.agentId || job.agentId === owner);
}

/** Compare rich baselines by identity; legacy baselines keep conservative name/multiplicity checks. */
export function verifyUpdateBaseline(
  input: unknown,
  transcripts: Record<string, number>,
  after: CronJobIdentity[] | string[] | null,
  transition?: CronTransition,
): UpdateVerification {
  const baseline = parseUpdateBaseline(input);
  if (!baseline) return { sessions: 0, lostEvents: [], missingCronJobs: null, ok: false };
  const lostEvents = Object.entries(baseline.transcripts)
    .filter(([session, before]) => (transcripts[session] ?? 0) < before)
    .map(([session, before]) => ({ session, before, after: transcripts[session] ?? 0 }));
  let missingCronJobs: string[] | null = null;
  const retiredCronJobs: string[] = [];
  if (baseline.cronJobs !== null && after !== null) {
    if (baseline.cronBaselineVersion === 1) {
      const identities = parseCronJobIdentities(after);
      if (identities && baseline.cronJobIdentities) {
        missingCronJobs = [];
        const current = new Map(identities.map((job) => [job.id, job]));
        for (const job of baseline.cronJobIdentities) {
          const found = current.get(job.id);
          if (found && found.declarationKey === job.declarationKey && found.agentId === job.agentId) continue;
          if (!found && isRetiredOwnedCron(job, transition)) retiredCronJobs.push(job.name ?? job.id);
          else missingCronJobs.push(job.name ?? job.id);
        }
      }
    } else {
      const identities = parseCronJobIdentities(after);
      const names = identities ? cronNames(identities) : after.every(text) ? after as string[] : null;
      if (names) {
        const counts = new Map<string, number>();
        for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
        missingCronJobs = baseline.cronJobs.filter((name) => {
          const count = counts.get(name) ?? 0;
          if (!count) return true;
          counts.set(name, count - 1);
          return false;
        });
      }
    }
  }
  return {
    sessions: Object.keys(baseline.transcripts).length,
    lostEvents,
    missingCronJobs,
    ...(retiredCronJobs.length ? { retiredCronJobs } : {}),
    ok: lostEvents.length === 0 && missingCronJobs !== null && missingCronJobs.length === 0,
  };
}

export type PreUpdateCronEvidence =
  | { kind: 'verified'; jobs: CronJobIdentity[]; file: string; sha256: string }
  | { kind: 'unavailable'; reason: string };
export type PreUpdateCronEvidenceReader = (input: {
  agentId: string; backupFile: string; fromVersion: string; toVersion: string; baselineJson: string;
}) => Promise<PreUpdateCronEvidence>;

export interface CronRepairRow {
  id: number; agent_id: string; status: string; from_version: string | null; to_version: string;
  backup_file: string | null; baseline_json: string | null; verify_json: string | null; error: string | null;
  resolved_at?: number | null; cron_repair_json?: string | null;
}

/** Only a recorded cron-only verification failure can enter the separate retirement audit. */
export function isCronRepairCandidate(row: CronRepairRow): boolean {
  if (row.status !== 'failed' || row.resolved_at != null || !hasKnownCronRetirement({ fromVersion: row.from_version, toVersion: row.to_version })
    || !row.error?.startsWith('Cron jobs missing after the update: ') || !row.backup_file) return false;
  const baseline = readUpdateBaseline(row.baseline_json);
  if (!baseline || !baseline.cronJobs?.length || !row.verify_json) return false;
  try {
    const verification: unknown = JSON.parse(row.verify_json);
    return record(verification) && verification.ok === false && Array.isArray(verification.lostEvents) && verification.lostEvents.length === 0
      && Array.isArray(verification.missingCronJobs) && verification.missingCronJobs.length > 0 && verification.missingCronJobs.every(text);
  } catch { return false; }
}

/** Backups must prove the complete baseline, including duplicate names; they are never name whitelists. */
export function baselineWithCronEvidence(row: CronRepairRow, evidence: PreUpdateCronEvidence): UpdateBaseline | null {
  const baseline = readUpdateBaseline(row.baseline_json);
  if (!baseline || !isCronRepairCandidate(row) || evidence.kind !== 'verified' || evidence.file !== row.backup_file
    || !/^[a-f0-9]{64}$/i.test(evidence.sha256)) return null;
  const jobs = parseCronJobIdentities(evidence.jobs);
  if (!jobs || !sameNames(baseline.cronJobs ?? [], cronNames(jobs))) return null;
  if (baseline.cronBaselineVersion === 1) {
    const archived = new Map(jobs.map((job) => [job.id, job]));
    if (!baseline.cronJobIdentities?.every((job) => JSON.stringify(archived.get(job.id)) === JSON.stringify(job))) return null;
  }
  return { ...baseline, cronBaselineVersion: 1, cronJobIdentities: jobs };
}

export interface CronRepairAudit {
  version: 1;
  policy: 'retired-skill-collection-review-v1';
  status: 'unresolved' | 'verified';
  reason: string;
  checkedAtMs: number;
  source?: { file: string; sha256: string };
  verification?: UpdateVerification;
}

export function readCronRepairAudit(json: string | null | undefined): CronRepairAudit | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return record(value) && value.version === 1 && value.policy === 'retired-skill-collection-review-v1'
      && (value.status === 'verified' || value.status === 'unresolved') && text(value.reason) && typeof value.checkedAtMs === 'number'
      ? value as unknown as CronRepairAudit : null;
  } catch { return null; }
}

/** Repeating an unchanged audit is a no-op even when the wall clock moved. */
export function sameCronRepairAudit(previous: CronRepairAudit | null, next: CronRepairAudit): boolean {
  if (!previous) return false;
  const { checkedAtMs: _previousTime, ...a } = previous;
  const { checkedAtMs: _nextTime, ...b } = next;
  return JSON.stringify(a) === JSON.stringify(b);
}

interface SqlDb { prepare(sql: string): { run(...args: unknown[]): { changes: number | bigint } } }

/** Compare-and-set the latest still-failed row; never replace the original verification or failure. */
export function recordCronRepairAuditSql(db: SqlDb, row: CronRepairRow, audit: CronRepairAudit): boolean {
  if (!isCronRepairCandidate(row) || sameCronRepairAudit(readCronRepairAudit(row.cron_repair_json), audit)) return false;
  const verified = audit.status === 'verified';
  if (verified && (!audit.source || audit.source.file !== row.backup_file || !/^[a-f0-9]{64}$/i.test(audit.source.sha256)
    || audit.verification?.ok !== true || audit.verification.lostEvents.length !== 0
    || audit.verification.missingCronJobs?.length !== 0 || !audit.verification.retiredCronJobs?.length)) return false;
  const info = db.prepare(
    `UPDATE agent_upgrades SET cron_repair_json = ?, resolved_at = ?, resolution = ?
      WHERE id = ? AND agent_id = ? AND status = 'failed' AND resolved_at IS NULL
        AND baseline_json IS ? AND verify_json IS ? AND error IS ? AND backup_file IS ? AND cron_repair_json IS ?
        AND id = (SELECT MAX(id) FROM agent_upgrades WHERE agent_id = ?)
        AND NOT EXISTS (SELECT 1 FROM agent_restores WHERE agent_id = ? AND finished_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM agent_recreates WHERE agent_id = ? AND finished_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM agent_edits WHERE agent_id = ? AND finished_at IS NULL)`,
  ).run(JSON.stringify(audit), verified ? audit.checkedAtMs : null,
    verified ? 'Verified after correcting the comparison of an upstream-owned retired cron job; original verification retained' : null,
    row.id, row.agent_id, row.baseline_json, row.verify_json, row.error, row.backup_file, row.cron_repair_json ?? null,
    row.agent_id, row.agent_id, row.agent_id, row.agent_id);
  return Number(info.changes) > 0;
}
