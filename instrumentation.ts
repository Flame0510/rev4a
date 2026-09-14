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
  }
}
