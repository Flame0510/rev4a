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
      syncAllAgents();
    } catch {
      // Best-effort — don't block startup if sync fails
      console.warn('[olympus] Failed to sync agents on startup');
    }
  }
}
