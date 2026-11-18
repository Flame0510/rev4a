import { openDb } from '@/lib/db';
import { agentBusyReason, currentBusyReason } from '@/lib/agent-busy';

export class AgentOperationBusyError extends Error {}

/**
 * Admit a synchronous Docker mutation after all asynchronous reads. The busy check runs inside a
 * short IMMEDIATE transaction, so it sees every createJobState claim committed by any process; the
 * Docker command then runs right after it, outside the transaction. Holding the write reservation
 * through the command (up to 35 s for a stop) would block every other writer of this database and
 * make them fail with SQLITE_BUSY. The window left between the check and the command is a few
 * microseconds of synchronous code. This writes no job/history row.
 */
export async function runAgentOperation<T>(agentId: string, mutate: () => T): Promise<T> {
  const busy = await agentBusyReason(agentId);
  if (busy) throw new AgentOperationBusyError(busy);
  const db = openDb(false);
  try {
    db.transaction(() => {
      // Revalidate owners after the async backup probe, inside the same reservation
      // that protects the command from a competing persisted lifecycle claim.
      const current = currentBusyReason(agentId);
      if (current) throw new AgentOperationBusyError(current);
      for (const table of ['agent_upgrades', 'agent_recreates', 'agent_restores', 'agent_edits']) {
        const row = db.prepare(`SELECT status${table === 'agent_upgrades' ? ', cron_model_repair_claim' : ''}
          FROM ${table} WHERE agent_id = ? ORDER BY id DESC LIMIT 1`).get(agentId) as
          { status: string; cron_model_repair_claim?: number | null } | undefined;
        if (row && (!['done', 'failed', 'interrupted', 'rolled_back', 'rollback_failed'].includes(row.status)
          || row.cron_model_repair_claim != null)) {
          throw new AgentOperationBusyError('Another lifecycle operation of this agent started; refresh and retry');
        }
      }
    }).immediate();
  } finally {
    db.close();
  }
  return mutate();
}
