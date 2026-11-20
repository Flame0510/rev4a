/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * Syncs the provider gateway baseUrl to all agent containers on boot.
 * This ensures agents pick up any domain/env changes after a restart,
 * VPS reboot, or crash recovery — no manual Sync button needed.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // The credential vault holds secrets in clear: tighten it to 0600 at every start, so an
    // install updated from a version that created it 0644 is fixed now, not at its first use.
    try {
      const { secureDbFiles } = await import('./lib/credentials/file-mode');
      const { CREDENTIALS_DB_PATH } = await import('./lib/credentials/db');
      secureDbFiles(CREDENTIALS_DB_PATH);
    } catch {
      console.warn('[rev4a] Could not check the credential vault file mode');
    }
    let startupSynced = false;
    try {
      const { syncAllAgents } = await import('./app/api/gateway/sync');
      // The outcome used to be discarded. syncAllAgents reports failures instead of
      // throwing, so the catch below never saw a sync that reached no container —
      // Docker not yet up at boot left the fleet stale with nothing in the log.
      const outcome = await syncAllAgents();
      startupSynced = outcome.ok;
      if (outcome.ok) {
        console.log(`[rev4a] Startup sync: ${outcome.summary}`);
      } else {
        console.warn(`[rev4a] Startup sync incomplete: ${outcome.summary} Run Sync All Agents once the cause is fixed.`);
      }
    } catch {
      // Best-effort — don't block startup if sync fails
      console.warn('[rev4a] Failed to sync agents on startup');
    }
    // Repair credentials left failed by the old 30-second kill or a rotated Gateway token.
    // Never await the deliveries: a slow Gateway must not delay dashboard startup.
    import('./lib/credentials/delivery')
      .then(({ repairCredentialTimeoutsAtStartup }) => repairCredentialTimeoutsAtStartup())
      .catch(() => console.warn('[rev4a] Could not check credentials for startup repair'));
    // Prices that change with the time of day (DeepSeek off-peak): write the new rates
    // into every agent at each change, so OpenClaw prices each call at the rate it ran at.
    // A startup sync that missed an agent is written again by the first check.
    try {
      const { startPriceScheduleSync } = await import('./lib/price-schedule-sync');
      startPriceScheduleSync(startupSynced);
    } catch {
      console.warn('[rev4a] Could not start the price schedule re-sync');
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
    // Updates recorded as failed or interrupted although the agent has run the new version fine
    // since (a slow start, a restart during the wait): proved with the stored baseline, then marked
    // resolved. Idempotent, not awaited, so it cannot delay the server start.
    import('./lib/agent-update')
      .then(async ({ resolveFailedUpdatesAtStartup }) => {
        const { readPreUpdateCronEvidence } = await import('./lib/backup-cron-evidence');
        return resolveFailedUpdatesAtStartup(readPreUpdateCronEvidence);
      })
      .catch((e) => console.warn(`[rev4a] Could not re-check failed agent updates on startup: ${(e as Error)?.message ?? e}`));
    import('./lib/agent-update-cron-account')
      .then(({ startCronAccountModelRecovery }) => startCronAccountModelRecovery())
      .catch(() => console.warn('[rev4a] Could not start pending cron model recovery'));
    // Recreates cut off by the restart: the row becomes `interrupted` and an agent the
    // backup had stopped is started again, so nothing stays down.
    try {
      const { recoverInterruptedRecreates } = await import('./lib/agent-recreate');
      const interrupted = await recoverInterruptedRecreates();
      if (interrupted) console.warn(`[rev4a] ${interrupted} agent recreate(s) were interrupted by the restart`);
    } catch {
      console.warn('[rev4a] Could not check agent recreates on startup');
    }
    // An interrupted restore needs review: mark it without extracting again or
    // restarting an agent whose current volume may contain partial or newer work.
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
    // Backups of older releases sit in the Docker volume rev4a-backups: move them, one verified file at a
    // time, into <data>/backups (plain files). Resumable and idempotent; a no-op once the volume is gone.
    // Not awaited, so it cannot delay the server start.
    import('./lib/backups-migration-host')
      .then(({ startBackupsMigration }) => startBackupsMigration())
      .catch((e) => console.warn(`[rev4a] Could not start the backups migration: ${(e as Error)?.message ?? e}`));
    // Agents on an image that lost every tag: tag it by identity so its version is known
    // (a recreate then moves the agent to the pinned build) and retention can remove it later.
    // Not awaited: with many images it must not delay the server start.
    import('./lib/agent-images')
      .then(({ repairUntaggedAgentImages }) => repairUntaggedAgentImages())
      .then((tagged) => {
        if (tagged.length) console.log(`[rev4a] Tagged ${tagged.length} untagged agent image(s): ${tagged.join(', ')}`);
      })
      .catch((e) => console.warn(`[rev4a] Could not check agent images on startup: ${(e as Error)?.message ?? e}`));
    // Agents whose token file was created 0644 by an older release: tighten it to 0600 in every
    // RUNNING agent. Idempotent, only ever restricts. Stopped agents are fixed at a later Rev4a start.
    // Not awaited, so it cannot delay the server start.
    import('./lib/agent-token')
      .then(async ({ repairAllTokenFileModes }) => {
        const { promisify } = await import('node:util');
        const { execFile } = await import('node:child_process');
        const run = promisify(execFile);
        const changed = await repairAllTokenFileModes(async () => {
          const { stdout } = await run(
            'docker',
            ['ps', '--filter', 'label=AGENT_ID', '--format', '{{.Names}}'],
            { encoding: 'utf-8', timeout: 5000 },
          );
          return stdout.split('\n').map((n) => n.trim()).filter(Boolean);
        });
        if (changed) console.log(`[rev4a] Restricted the gateway token file on ${changed} agent(s)`);
      })
      .catch((e) => console.warn(`[rev4a] Could not check the agent token files on startup: ${(e as Error)?.message ?? e}`));
    // Before 1.30.1 the agents token Save & Sync skipped stopped agents, which then kept the old token
    // (even across Recreate: the volume file wins over the environment). Give every stopped agent that is
    // not on the saved token the saved one, read at its next start. Idempotent, busy agents left for the
    // next start, held under the token lock so a Save cannot interleave. Not awaited.
    Promise.all([import('./lib/agent-token'), import('./lib/agent-token-lock'), import('./lib/agent-busy'), import('./lib/rev4a-paths')])
      .then(async ([{ repairStoppedAgentTokens, isValidAgentsToken }, { withTokenLock }, { agentBusyReason }, { AGENTS_TOKEN_FILE }]) => {
        const fs = await import('node:fs');
        const { promisify } = await import('node:util');
        const { execFile } = await import('node:child_process');
        const run = promisify(execFile);
        const repaired = await withTokenLock(async () => {
          // Read under the lock: a Save that ran first is the token every agent must end on.
          let current: unknown;
          try { current = JSON.parse(fs.readFileSync(AGENTS_TOKEN_FILE, 'utf-8')).token; } catch { return []; }
          if (!isValidAgentsToken(current)) return [];
          return repairStoppedAgentTokens(current, async () => {
            const { stdout } = await run('docker', ['ps', '-a', '--filter', 'label=AGENT_ID', '--filter', 'status=exited',
              '--filter', 'status=created', '--format', '{{.Names}}\t{{.Label "AGENT_ID"}}'], { encoding: 'utf-8', timeout: 5000 });
            return stdout.split('\n').filter(Boolean).map((line) => {
              const [name = '', agentId = ''] = line.split('\t');
              return { name: name.trim(), agentId: agentId.trim() };
            }).filter((agent) => agent.name);
          }, {
            isBusy: async (agentId) => Boolean(await agentBusyReason(agentId)),
            inspect: async (name) => {
              const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Status}}{{range .Config.Env}}\n{{.}}{{end}}', name],
                { encoding: 'utf-8', timeout: 5000 });
              const [state = '', ...env] = stdout.replace(/\n$/, '').split('\n');
              const envLine = env.find((line) => line.startsWith('OPENCLAW_GATEWAY_TOKEN='));
              // Verbatim, as the entrypoint uses it.
              return { state: state.trim(), envToken: envLine ? envLine.slice('OPENCLAW_GATEWAY_TOKEN='.length) : '' };
            },
            warn: (m) => console.warn(`[rev4a] ${m}`),
          });
        });
        if (repaired.length) console.log(`[rev4a] Gave the saved agents token to ${repaired.length} stopped agent(s): ${repaired.join(', ')}`);
      })
      .catch((e) => console.warn(`[rev4a] Could not check stopped agents' tokens on startup: ${(e as Error)?.message ?? e}`));
    // Agents already connected to Claude: switch off the tools no agent uses on Claude runs, only where
    // tools.byProvider.anthropic.deny is absent. One running agent at a time; not awaited, so it cannot
    // delay the server start. Runs here, not in the daemon: the config lock lives in this process.
    import('./lib/claude-lean-tools')
      .then(({ repairLeanClaudeToolsAtStartup }) => repairLeanClaudeToolsAtStartup())
      .catch((e) => console.warn(`[rev4a] Could not check Claude tools on startup: ${(e as Error)?.message ?? e}`));
    if (process.env.REV4A_SUPERVISED === '1' && process.env.REV4A_DOMAIN?.trim()) {
      void import('./lib/domain-sync').then(({ syncDomainRoutes }) => syncDomainRoutes())
        .catch(() => console.warn('[domain] Could not load Caddy sync.'));
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
