// Read access to the agent costs database. costs.db has two writers: daemon.js (its agent_cost_*
// and vendor tables) and the dashboard's provider proxy (`proxy_usage_hourly`, which it may
// create before the daemon exists). Readers here always use a read-only handle.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DB_PATH } from './db';

/** Next to events.db, as daemon.js places it; its own file, like metrics.db. */
export const COSTS_DB_PATH = path.join(path.dirname(DB_PATH), 'costs.db');

const TABLES = ['agent_cost_daily', 'agent_cost_model_daily', 'agent_cost_sessions', 'agent_cost_sources'];

/**
 * Open the costs database read-only, or null when there is nothing to read yet: no file
 * (first start, or a daemon that never ran) or one without the daemon's tables. The
 * daemon owns its schema; the proxy owns `proxy_usage_hourly`.
 */
export function openCostsDb(): Database.Database | null {
  if (!fs.existsSync(COSTS_DB_PATH)) return null;
  const db = new Database(COSTS_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(', ')})`)
      .get(...TABLES) as { n: number };
    if (row.n === TABLES.length) return db;
  } catch (e) {
    db.close();
    throw e;
  }
  db.close();
  return null;
}
