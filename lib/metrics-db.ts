// Read access to the machine metrics database (daemon.js writes it).
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DB_PATH } from './db';

/** History ranges of the System page and their span in seconds (GET /api/metrics and /api/metrics/containers). */
export const METRIC_RANGES = { '1h': 3600, '24h': 86_400, '7d': 7 * 86_400, '30d': 30 * 86_400 } as const;
export type MetricRange = keyof typeof METRIC_RANGES;

/** Next to events.db, as daemon.js places it; its own file so the event log stays clean. */
export const METRICS_DB_PATH = path.join(path.dirname(DB_PATH), 'metrics.db');

/**
 * Open the metrics database read-only, or null when there is nothing to read yet: no file
 * (first start, or a daemon that never ran), a file without the daemon's tables (it failed
 * right after creating it), or a file that cannot be opened at all (corrupt, locked — the
 * caller answers "no data", never a 500). The daemon owns the schema. Never throws.
 */
export function openMetricsDb(): Database.Database | null {
  if (!fs.existsSync(METRICS_DB_PATH)) return null;
  let db: Database.Database;
  try {
    db = new Database(METRICS_DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const tables = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('system_metrics', 'system_disks')")
      .get() as { n: number };
    if (tables.n === 2) return db;
  } catch {
    /* fall through: unreadable schema counts as nothing to read */
  }
  db.close();
  return null;
}

/**
 * Seconds-since-epoch of the newest sample, or null when there is none. `available` is
 * false when there is no metrics database to read, `error` when it could not be read.
 * Never throws: a broken metrics.db must not fail a caller about something else.
 */
export function latestMetricSample(): { available: boolean; ts: number | null; error?: string } {
  let db: Database.Database | null = null;
  try {
    db = openMetricsDb();
    if (!db) return { available: false, ts: null };
    const row = db.prepare('SELECT MAX(ts) AS latest FROM system_metrics').get() as { latest: number | null };
    return { available: true, ts: row.latest };
  } catch (e) {
    return { available: false, ts: null, error: (e as Error).message };
  } finally {
    db?.close();
  }
}
