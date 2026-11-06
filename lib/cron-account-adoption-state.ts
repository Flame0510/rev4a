/** Rev4a's durable undo record for a native cron model used only to select an account. */
import { openDb } from '@/lib/db';

export interface CronModelRecord {
  job_id: string;
  profile_id: string;
  original_model: string | null;
  temporary_model: string;
  finished_at: number | null;
  superseded_at: number | null;
}
export interface CronModelJournal {
  get(jobId: string): CronModelRecord | null;
  remember(record: Omit<CronModelRecord, 'finished_at' | 'superseded_at'>): CronModelRecord;
  finish(jobId: string): void;
}

export function cronModelJournal(container: string, updateId: number): CronModelJournal {
  const get = (jobId: string): CronModelRecord | null => {
    const db = openDb(true);
    try { return db.prepare('SELECT * FROM cron_account_adoptions_by_update WHERE container = ? AND update_id = ? AND job_id = ?').get(container, updateId, jobId) as CronModelRecord | undefined ?? null; }
    finally { db.close(); }
  };
  return {
    get,
    remember(record) {
      const db = openDb(false);
      try {
        return db.transaction(() => {
          // Never replace the original with the temporary pin observed on a retry.
          db.prepare(`INSERT OR IGNORE INTO cron_account_adoptions_by_update
            (container, update_id, job_id, profile_id, original_model, temporary_model) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(container, updateId, record.job_id, record.profile_id, record.original_model, record.temporary_model);
          return db.prepare('SELECT * FROM cron_account_adoptions_by_update WHERE container = ? AND update_id = ? AND job_id = ?').get(container, updateId, record.job_id) as CronModelRecord;
        }).immediate();
      } finally { db.close(); }
    },
    finish(jobId) {
      const db = openDb(false);
      try { db.prepare('UPDATE cron_account_adoptions_by_update SET finished_at = COALESCE(finished_at, ?) WHERE container = ? AND update_id = ? AND job_id = ?').run(Date.now(), container, updateId, jobId); }
      finally { db.close(); }
    },
  };
}

/** Called under the new update's lifecycle claim, before its worker starts. */
export function supersedeCronModelUpdates(container: string, updateId: number, agentId: string, transactionDb?: ReturnType<typeof openDb>): void {
  const db = transactionDb ?? openDb(false);
  try {
    const now = Date.now();
    const changed = db.prepare(`UPDATE cron_account_adoptions_by_update SET superseded_at = ?, finished_at = ?
      WHERE finished_at IS NULL AND update_id < ? AND (container = ? OR update_id IN
        (SELECT id FROM agent_upgrades WHERE agent_id = ?))`).run(now, now, updateId, container, agentId).changes;
    if (changed) console.log(`[update] Superseded ${changed} unfinished cron account journal(s)`);
  } finally { if (!transactionDb) db.close(); }
}

export function pendingCronModelUpdates(): { container: string; update_id: number }[] {
  const db = openDb(true);
  try { return db.prepare(`SELECT DISTINCT j.container, j.update_id FROM cron_account_adoptions_by_update j
    JOIN agent_upgrades u ON u.id = j.update_id
    WHERE j.finished_at IS NULL AND j.superseded_at IS NULL
      AND u.id = (SELECT MAX(latest.id) FROM agent_upgrades latest WHERE latest.agent_id = u.agent_id)
      AND u.status IN ('done', 'failed', 'interrupted')`).all() as { container: string; update_id: number }[]; }
  finally { db.close(); }
}
