'use strict';

/**
 * Retention for the events table in events.db. The daemon calls it on its own timer, so it
 * runs on every host, whether or not OpenClaw is installed and whether or not metrics.db
 * opened. The 7-day cron retention in daemon.js is separate and unchanged.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const EVENTS_RETENTION_MS = 30 * DAY_MS;
// A long single DELETE holds the write lock and blocks the API's readers.
const PRUNE_BATCH_SIZE = 5000;

/**
 * Delete events older than the retention window, in batches.
 * @param {import('better-sqlite3').Database} db
 * @param {number} nowMs
 * @param {{ retentionMs?: number }} [options]
 * @returns {number} rows deleted
 */
function pruneEvents(db, nowMs, options) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('nowMs must be a finite number');
  }
  const retentionMs = options && options.retentionMs !== undefined
    ? options.retentionMs
    : EVENTS_RETENTION_MS;
  if (typeof retentionMs !== 'number' || !Number.isFinite(retentionMs) || retentionMs < DAY_MS) {
    throw new RangeError('retentionMs must be a finite number of at least one day');
  }

  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get();
  if (!hasTable) return 0;

  const cutoff = nowMs - retentionMs;
  const del = db.prepare(
    'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? LIMIT ?)'
  );
  let total = 0;
  for (;;) {
    const { changes } = del.run(cutoff, PRUNE_BATCH_SIZE);
    total += changes;
    if (changes < PRUNE_BATCH_SIZE) break;
  }
  return total;
}

module.exports = { EVENTS_RETENTION_MS, pruneEvents };
