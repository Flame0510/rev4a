/** Types for the CommonJS events retention helper shared with daemon.js. */

export const EVENTS_RETENTION_MS: number;

export interface PruneEventsOptions {
  /** Retention window in milliseconds; at least one day. Defaults to EVENTS_RETENTION_MS. */
  retentionMs?: number;
  /** Stop after the batch that reaches this many deleted rows (positive integer). Default: no limit. */
  maxRows?: number;
}

/** Minimal shape of a better-sqlite3 database that pruneEvents needs. */
export interface PrunableDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
  };
}

export function pruneEvents(db: PrunableDatabase, nowMs: number, options?: PruneEventsOptions): number;
