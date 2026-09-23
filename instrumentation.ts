/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * Syncs the provider gateway baseUrl to all agent containers on boot.
 * This ensures agents pick up any domain/env changes after a restart,
 * VPS reboot, or crash recovery — no manual Sync button needed.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { syncAllAgents } = await import('./app/api/gateway/sync');
      // The outcome used to be discarded. syncAllAgents reports failures instead of
      // throwing, so the catch below never saw a sync that reached no container —
      // Docker not yet up at boot left the fleet stale with nothing in the log.
      const outcome = syncAllAgents();
      if (outcome.ok) {
        console.log(`[rev4a] Startup sync: ${outcome.summary}`);
      } else {
        console.warn(`[rev4a] Startup sync incomplete: ${outcome.summary} Run Sync All Agents once the cause is fixed.`);
      }
    } catch {
      // Best-effort — don't block startup if sync fails
      console.warn('[rev4a] Failed to sync agents on startup');
    }
    // Updates cut off by the restart: no job runs in a fresh process, so any update
    // still marked active becomes `interrupted` and waits for the operator.
    try {
      const { recoverInterruptedUpdates } = await import('./lib/agent-update');
      const interrupted = await recoverInterruptedUpdates();
      if (interrupted) console.warn(`[rev4a] ${interrupted} agent update(s) were interrupted by the restart`);
    } catch {
      console.warn('[rev4a] Could not check agent updates on startup');
    }
    // Recreates cut off by the restart: the row becomes `interrupted` and an agent the
    // backup had stopped is started again, so nothing stays down.
    try {
      const { recoverInterruptedRecreates } = await import('./lib/agent-recreate');
      const interrupted = await recoverInterruptedRecreates();
      if (interrupted) console.warn(`[rev4a] ${interrupted} agent recreate(s) were interrupted by the restart`);
    } catch {
      console.warn('[rev4a] Could not check agent recreates on startup');
    }
    // Restores cut off by the restart: same treatment — the row becomes `interrupted`
    // and a container left stopped is started again.
    try {
      const { recoverInterruptedRestores } = await import('./lib/agent-restore');
      const interrupted = await recoverInterruptedRestores();
      if (interrupted) console.warn(`[rev4a] ${interrupted} agent restore(s) were interrupted by the restart`);
    } catch {
      console.warn('[rev4a] Could not check agent restores on startup');
    }
    // Edits cut off by the restart: same treatment.
    try {
      const { recoverInterruptedEdits } = await import('./lib/agent-edit');
      const interrupted = await recoverInterruptedEdits();
      if (interrupted) console.warn(`[rev4a] ${interrupted} agent edit(s) were interrupted by the restart`);
    } catch {
      console.warn('[rev4a] Could not check agent edits on startup');
    }
    // Cold backups whose helper outlived a Rev4a restart: finish the exited ones (the
    // agent is started again if it was running) and keep watching the rest.
    try {
      const { reconcileColdBackups } = await import('./lib/cold-backup');
      await reconcileColdBackups();
    } catch {
      console.warn('[rev4a] Could not reconcile cold backups on startup');
    }
    // Retention for the lifecycle job tables: the panel reads the latest row of each
    // agent, so the history is trimmed to the newest rows per agent. Best-effort.
    try {
      const { pruneLifecycleRows } = await import('./lib/agent-jobs-maintenance');
      const removed = pruneLifecycleRows().filter((r) => r.removed > 0);
      if (removed.length) {
        console.log(`[rev4a] Pruned job history: ${removed.map((r) => `${r.table} ${r.removed}`).join(', ')}`);
      }
    } catch {
      console.warn('[rev4a] Could not prune the lifecycle job history');
    }
  }
}
