import type Database from 'better-sqlite3';

/**
 * The `events.type` values daemon.js writes when a run fails: `fail` for an OpenClaw
 * error signal or an orphan close that resolved to error, `spawn_timeout` for a
 * sub-agent that vanished while working. Case-sensitive on purpose — the daemon writes
 * them lowercase, and `FAIL`, `failed`, `error` or `spawn` are not failures.
 */
export const FAILURE_EVENT_TYPES = ['fail', 'spawn_timeout'] as const;

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
