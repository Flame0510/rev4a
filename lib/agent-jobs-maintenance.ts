/**
 * Retention for the lifecycle job tables (`agent_upgrades`, `agent_recreates`,
 * `agent_restores`, `agent_edits`). They record every update, recreate, restore and edit
 * an agent has been through, and nothing pruned them: the rows grew for the life of the
 * installation while the panel only ever reads the latest one of each agent. Each table
 * keeps the newest `KEEP_PER_AGENT` rows per agent; the rest is history.
 *
 * Best-effort: a failure is logged and does not stop the others or the startup.
 */
import { pruneUpdates } from '@/lib/agent-update-state';
import { pruneRecreates } from '@/lib/agent-recreate-state';
import { pruneRestores } from '@/lib/agent-restore-state';
import { pruneEdits } from '@/lib/agent-edit-state';

/** Rows kept per agent, per table. Enough to see the recent history of an agent. */
const KEEP_PER_AGENT = 20;

export function pruneLifecycleRows(keepPerAgent: number = KEEP_PER_AGENT): { table: string; removed: number }[] {
  const prunes: [string, (keep: number) => number][] = [
    ['agent_upgrades', pruneUpdates],
    ['agent_recreates', pruneRecreates],
    ['agent_restores', pruneRestores],
    ['agent_edits', pruneEdits],
  ];
  const result: { table: string; removed: number }[] = [];
  for (const [table, prune] of prunes) {
    try {
      result.push({ table, removed: prune(keepPerAgent) });
    } catch (e) {
      console.warn(`[rev4a] could not prune ${table}: ${(e as Error).message}`);
    }
  }
  return result;
}
