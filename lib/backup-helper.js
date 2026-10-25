'use strict';

/**
 * What identifies a cold-backup helper container (lib/cold-backup.ts runs one per job, named
 * `rev4a-backup-<agentId>` and labelled with the agent and the kind). One place, because the
 * daemon's sampler (lib/docker-stats.js), the System page's query (lib/container-metrics.ts)
 * and the job itself must agree on it. Plain CommonJS: the daemon requires it.
 */

const HELPER_PREFIX = 'rev4a-backup-';
const LABEL_AGENT = 'rev4a.backup.agent';
const LABEL_KIND = 'rev4a.backup.kind';

/** True for a container name that is a cold-backup helper's. */
function isBackupHelperName(name) {
  return typeof name === 'string' && name.startsWith(HELPER_PREFIX);
}

/** What the System page says about a job's kind; anything unknown reads as a manual backup. */
function backupKindLabel(kind) {
  if (kind === 'preupdate') return 'before update';
  if (kind === 'prerecreate') return 'before recreate';
  return 'manual';
}

module.exports = { HELPER_PREFIX, LABEL_AGENT, LABEL_KIND, isBackupHelperName, backupKindLabel };
