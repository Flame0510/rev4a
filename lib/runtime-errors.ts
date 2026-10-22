import type Database from 'better-sqlite3';

/**
 * The `events.type` values that mean a run failed: `session_failed`, written by the session collector
 * for a failed session or cron run, and the two types of the previous host poll, `fail` and
 * `spawn_timeout`, which older installs still hold (they age out in 30 days). Case-sensitive on
 * purpose: `FAIL`, `failed`, `error` or `spawn` are not failures.
 */
export const FAILURE_EVENT_TYPES = ['fail', 'spawn_timeout', 'session_failed'] as const;

/**
 * How many failure events (`FAILURE_EVENT_TYPES`) the `events` table holds at or after
 * `sinceMs`. The `events.ts` column is in milliseconds.
 *
 * A missing `events` table or one without a `type` column counts as zero instead of
 * throwing: an older or half-initialized database still has to answer this check. The
 * type values and the cutoff are bound parameters, never interpolated.
 */
export function countFailureEvents(db: Database.Database, sinceMs: number): number {
  const hasTypeColumn = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[])
    .some((column) => column.name === 'type');
  if (!hasTypeColumn) return 0;

  const placeholders = FAILURE_EVENT_TYPES.map(() => '?').join(', ');
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM events WHERE type IN (${placeholders}) AND ts >= ?`)
    .get(...FAILURE_EVENT_TYPES, sinceMs) as { total: number };
  return Number(row.total);
}
