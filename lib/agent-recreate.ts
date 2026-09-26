/**
 * Recreating an agent container on a given image while keeping everything else: the
 * persistent volume, the AGENT_*, MODEL_*, OPENCLAW_* and TZ environment, the AGENT_ID
 * and routing labels, the published ports and the network.
 *
 * Shared by the Update action (another version), the recreate action (same version,
 * `startAgentRecreate`) and the edit route (PATCH, synchronous, no backup). The caller
 * picks the image and takes care of backups.
 *
 * Arguments go to `docker` as an argv array, and environment values reach it through
 * its own environment (`-e KEY`), so the gateway token never sits in the process table.
 */
import { dockerFetch } from '@/lib/docker-socket';
import { runDocker, resolveRecreateImage } from '@/lib/agent-images';
import { hostPortsFromArgs } from '@/lib/agent-ports';
import { getHostPortHolders, describeHolder, type HostPortHolder } from '@/lib/agent-ports-server';
import { getMountFlags, applyRuntimeConfig } from '@/lib/agent-setup';
import { isValidAgentId } from '@/lib/container';
import { BACKUP_VOLUME, coldBackupStatus, isColdBackupRunning, startColdBackup, waitForColdBackup } from '@/lib/cold-backup';
import { waitForGatewayReady } from '@/lib/agent-readiness';
import { patchRev4aProvider } from '@/app/api/gateway/sync';
import { activeRecreateAgentIds, insertRecreate, isRecreateActive, latestRecreate, markInterruptedRecreates, updateRecreateRow, type AgentRecreateRow } from '@/lib/agent-recreate-state';
import { agentBusyReason } from '@/lib/agent-busy';

const KEEP_ENV_PREFIXES = ['AGENT_', 'MODEL_', 'OPENCLAW_', 'TZ='];
const KEEP_LABEL_PREFIXES = ['AGENT_ID', 'traefik.', 'description', 'maintainer'];

/** How long the recreated gateway may take to report ready. */
const RECREATE_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** A cold backup of a 13 GB volume takes ~8 minutes; anything past this is stuck. */
const COLD_BACKUP_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export interface AgentContainerInspect {
  Id?: string;
  Name?: string;
  Image?: string;
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  State?: { Running?: boolean; Status?: string };
  HostConfig?: { NetworkMode?: string; PortBindings?: Record<string, { HostPort?: string }[] | null> };
  NetworkSettings?: { Networks?: Record<string, unknown>; Ports?: Record<string, unknown> };
}

/** The container carrying `AGENT_ID=<agentId>`, inspected; null when there is none. */
export async function inspectAgentContainer(agentId: string): Promise<AgentContainerInspect | null> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`AGENT_ID=${agentId}`] }));
  const list = await dockerFetch<{ Id?: string }[]>('GET', `/containers/json?all=true&filters=${filters}`);
  const id = Array.isArray(list) ? list[0]?.Id : undefined;
  if (!id) return null;
  const info = await dockerFetch<AgentContainerInspect & { Id?: string }>('GET', `/containers/${id}/json`);
  return typeof info?.Id === 'string' ? info : null;
}

/**
 * Start the container and confirm it really came back. A container can report
 * `running` while its network endpoint failed to attach — the state a failed port bind
 * leaves behind — which would otherwise pass as a successful start.
 */
export async function startAndVerifyContainer(agentId: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await runDocker(['start', name], { timeoutMs: 60_000 });
  } catch (e) {
    return { ok: false, error: shortDockerError(e) };
  }
  const after = await inspectAgentContainer(agentId).catch(() => null);
  if (!after?.State?.Running) return { ok: false, error: 'the container is not running' };
  if (Object.keys(after.NetworkSettings?.Networks ?? {}).length === 0) {
    return { ok: false, error: 'the container came up without a network (one of its ports is taken by another container)' };
  }
  return { ok: true };
}

/** A docker failure carries a whole stack trace; the first line is the useful part. */
function shortDockerError(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  return message.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? message;
}

/**
 * Remove the container and run a new one on `image` with the same parameters. The new
 * container is named after the agent id, as the create route names it. `opts.env`
 * overrides single environment values (the edit route renames the agent this way),
 * `opts.portArgs` replaces the port bindings carried over from the inspect.
 */
export async function recreateAgentContainer(
  agentId: string,
  container: AgentContainerInspect,
  image: string,
  opts: { env?: Record<string, string>; portArgs?: string[] } = {},
): Promise<void> {
  // A running container carries its attached networks; a container whose network
  // endpoint was lost (or one inspected while detached) reports none, so the mode it
  // was created with is the fallback. 'default' is docker's alias for the default bridge.
  const network = Object.keys(container.NetworkSettings?.Networks ?? {})[0]
    ?? (container.HostConfig?.NetworkMode && container.HostConfig.NetworkMode !== 'default'
      ? container.HostConfig.NetworkMode
      : container.HostConfig?.NetworkMode === 'default' ? 'bridge' : undefined);
  if (!network) throw new Error('Cannot determine the network: the container has none attached');

  const env: Record<string, string> = {};
  for (const entry of container.Config?.Env ?? []) {
    if (!KEEP_ENV_PREFIXES.some((p) => entry.startsWith(p))) continue;
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  Object.assign(env, opts.env ?? {});

  const labelArgs = Object.entries(container.Config?.Labels ?? {})
    .filter(([k]) => KEEP_LABEL_PREFIXES.some((p) => k === p || k.startsWith(p)))
    .flatMap(([k, v]) => ['-l', `${k}=${v}`]);

  const portArgs = opts.portArgs ?? Object.entries(container.HostConfig?.PortBindings ?? {}).flatMap(([containerPort, bindings]) => {
    const hostPort = bindings?.[0]?.HostPort;
    if (!hostPort) return [];
    const proto = containerPort.includes('/udp') ? '/udp' : '';
    return ['-p', `${hostPort}:${containerPort.replace(/\/.*$/, '')}${proto}`];
  });

  // Refuse on a port clash before anything is removed: the old container is the
  // fallback the caller restarts, so a recreate refused here leaves the agent up. A
  // clash cannot be recovered from by retrying, so it must not reach `docker run`.
  const wanted = hostPortsFromArgs(portArgs);
  if (wanted.length && container.Id) {
    const held = await getHostPortHolders({ excludeContainerId: container.Id }).catch(() => new Map<number, HostPortHolder>());
    const conflicts = wanted.filter((p) => held.has(p));
    if (conflicts.length) {
      const holders = [...new Set(conflicts.map((p) => describeHolder(held.get(p)!)))];
      const many = conflicts.length > 1;
      throw new Error(
        `${many ? 'Ports' : 'Port'} ${conflicts.join(', ')} ${many ? 'are' : 'is'} already published by ${holders.join(', ')}. `
        + 'Change this agent\'s port range in the Edit panel, then retry: nothing was changed.',
      );
    }
  }

  const oldName = (container.Name ?? '').replace(/^\//, '') || agentId;
  await runDocker(['rm', '-f', oldName], { timeoutMs: 60_000 });

  const runArgs = (img: string): string[] => [
    'run', '-d',
    // tini as PID 1 collects orphaned processes (zombies) — see the create route. An
    // existing agent gets it here, the next time it is recreated, updated or edited.
    '--init',
    '--name', agentId,
    '--network', network,
    '--restart', 'unless-stopped',
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `agent-${agentId}-data:/root`,
    ...getMountFlags(),
    ...labelArgs,
    ...portArgs,
    img,
  ];

  try {
    await runDocker(runArgs(image), { timeoutMs: 120_000, env });
  } catch (first) {
    // A failed `docker run` here would leave the agent down (the old container is
    // already gone), so try once more. The usual cause is the image tag disappearing
    // between the caller resolving it and this run (retention untags in the
    // background) or a transient daemon error: re-resolving from the inspected
    // container re-tags the image id when the tag is gone. A second failure propagates.
    console.warn(`[agent:recreate] docker run failed for ${agentId}, retrying:`, (first as Error).message);
    await runDocker(['rm', '-f', agentId], { timeoutMs: 60_000 }).catch(() => {});
    const retryImage = await resolveRecreateImage(container).catch(() => image);
    try {
      await runDocker(runArgs(retryImage), { timeoutMs: 120_000, env });
    } catch (second) {
      // `docker run` creates the container before its network step, so a failed start
      // leaves a container behind — one that reports `running` with no network and
      // would be picked up as if it were the agent. Remove it, so the state the caller
      // reports matches reality.
      await runDocker(['rm', '-f', agentId], { timeoutMs: 60_000 }).catch(() => {});
      throw second;
    }
  }
}

// ── The recreate action ──────────────────────────────────────────────────────

export class RecreateRefusedError extends Error {}

/** Recreate jobs running in this process, so a second start for the same agent is refused. */
const running = new Set<string>();

/**
 * Start a recreate: a cold backup (the agent stops for it), then the container is
 * rebuilt on the image it already runs, and the gateway is waited for. Returns once
 * the job has started; the steps continue in the background and land in
 * `agent_recreates`, so a reload or a Rev4a restart never loses track of it.
 */
export async function startAgentRecreate(agentId: string): Promise<number> {
  if (!isValidAgentId(agentId)) throw new RecreateRefusedError('Invalid agent id');
  if (running.has(agentId)) throw new RecreateRefusedError('A recreate of this agent is already running');
  // Claimed synchronously, before the first await: two requests arriving together must
  // not both get past the guards (the second would later clear the first one's guard).
  running.add(agentId);
  try {
    // One source for every long operation: an update, recreate, restore, edit or backup.
    const busy = await agentBusyReason(agentId);
    if (busy) throw new RecreateRefusedError(busy);

    const container = await inspectAgentContainer(agentId);
    if (!container) throw new RecreateRefusedError(`No container found with AGENT_ID '${agentId}'`);
    // Refuse before any state is written when the image cannot be resolved.
    const image = await resolveRecreateImage(container);

    const id = insertRecreate(agentId, image);
    void runRecreate(id, agentId, image).finally(() => running.delete(agentId));
    return id;
  } catch (e) {
    running.delete(agentId);
    throw e;
  }
}

async function runRecreate(id: number, agentId: string, image: string): Promise<void> {
  let stoppedByBackup = false;
  try {
    const { file } = await startColdBackup(agentId, { kind: 'prerecreate', leaveStopped: true });
    stoppedByBackup = true;
    updateRecreateRow(id, { backup_file: file });
    const backup = await waitForColdBackup(agentId, { timeoutMs: COLD_BACKUP_WAIT_TIMEOUT_MS });
    if (backup.status !== 'succeeded') throw new Error(`The pre-recreate backup failed: ${backup.error ?? 'unknown error'}`);

    updateRecreateRow(id, { status: 'recreating' });
    const container = await inspectAgentContainer(agentId);
    if (!container) throw new Error('The agent container disappeared during the recreate');
    await recreateAgentContainer(agentId, container, image);
    stoppedByBackup = false;

    if (!(await waitForGatewayReady(agentId, RECREATE_READY_TIMEOUT_MS))) {
      throw new Error(`The gateway did not finish starting within ${RECREATE_READY_TIMEOUT_MS / 60_000} minutes`);
    }
    await applyRuntimeConfig(agentId);
    try {
      patchRev4aProvider(agentId);
    } catch (e) {
      console.error('[agent:recreate] provider patch failed:', (e as Error).message);
    }

    updateRecreateRow(id, { status: 'done' });

    // Retention: keep the newest two prerecreate archives (lib/cold-backup.ts). Best-effort.
    prunePrerecreateBackups(agentId)
      .then((removed) => { if (removed.length) console.log(`[agent:recreate] removed old prerecreate backups: ${removed.join(', ')}`); })
      .catch((err: unknown) => console.warn('[agent:recreate] backup cleanup failed:', (err as Error).message));
  } catch (e) {
    // A failure while the backup had stopped the old container and the recreate had
    // not run yet: start the old container again, so a failed recreate never leaves
    // the agent down. Nothing is left to start only when the rebuild itself failed
    // after removing the container — the retry inside recreateAgentContainer already
    // tried once, so the row says so and a new recreate is needed.
    if (stoppedByBackup) {
      const container = await inspectAgentContainer(agentId).catch(() => null);
      const name = container?.Name?.replace(/^\//, '');
      if (name && !container?.State?.Running) {
        await runDocker(['start', name], { timeoutMs: 60_000 }).catch(() => {});
      } else if (!container) {
        console.error(`[agent:recreate] ${agentId}: the container is gone after the failed rebuild; run Recreate again`);
      }
    }
    updateRecreateRow(id, { status: 'failed', error: shortError(e) });
  }
}

/** The useful part of an error for the panel: a `docker` failure carries a whole stack trace. */
function shortError(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[0] ?? message;
}

export interface AgentRecreateView {
  id: number;
  agentId: string;
  status: AgentRecreateRow['status'];
  image: string | null;
  backupFile: string | null;
  /** Cold backup progress while `backing_up`. */
  backupPercent: number | null;
  error: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

/** The latest recreate of an agent, with live backup progress. */
export async function agentRecreateView(agentId: string): Promise<AgentRecreateView | null> {
  const row = latestRecreate(agentId);
  if (!row) return null;
  const backupPercent = row.status === 'backing_up' ? (await coldBackupStatus(agentId).catch(() => null))?.percent ?? null : null;
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    image: row.image,
    backupFile: row.backup_file,
    backupPercent,
    error: row.error,
    startedAtMs: row.started_at,
    finishedAtMs: row.finished_at,
  };
}

/**
 * At startup, no recreate job can be running: rows still active were cut off by the
 * restart. They become `interrupted`; an agent the backup had stopped is started
 * again, best-effort — but never while its backup helper is still archiving the
 * volume, or the archive would be inconsistent. Startup is not held for that: each
 * agent is finished in the background.
 */
export async function recoverInterruptedRecreates(): Promise<number> {
  const ids = activeRecreateAgentIds();
  if (ids.size === 0) return 0;
  const interrupted = markInterruptedRecreates();
  for (const agentId of ids) void finishInterruptedRecreate(agentId);
  return interrupted;
}

async function finishInterruptedRecreate(agentId: string): Promise<void> {
  // A helper that outlived the restart keeps archiving; wait for it before touching
  // the agent. `waitForColdBackup` resolves immediately with the last job when none runs.
  const running = await isColdBackupRunning(agentId).catch(() => false);
  if (running) await waitForColdBackup(agentId).catch(() => null);
  const container = await inspectAgentContainer(agentId).catch(() => null);
  const name = container?.Name?.replace(/^\//, '');
  if (!name || container?.State?.Running) return;
  const started = await startAndVerifyContainer(agentId, name);
  if (!started.ok) console.warn(`[agent:recreate] ${agentId} did not come back after an interrupted recreate: ${started.error}`);
}

// ── Prerecreate retention ────────────────────────────────────────────────────

/** How many prerecreate archives to keep per agent once a recreate has committed. */
const KEEP_PRERECREATE = 2;

/**
 * Delete the agent's older prerecreate archives, keeping the newest
 * `KEEP_PRERECREATE`. Preupdate backups are not touched: they are the Update
 * rollback point. Returns the file names removed.
 */
export async function prunePrerecreateBackups(agentId: string): Promise<string[]> {
  const pattern = `agent-${agentId}-prerecreate-*.tar.gz`;
  const stale: string[] = [];
  await runDocker(
    // $PATTERN stays unquoted so the shell expands the wildcard; agent ids are
    // validated, so the pattern carries no shell metacharacters beyond the glob.
    ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, 'alpine', 'sh', '-c',
      'cd /backup && ls -1t $PATTERN 2>/dev/null | tail -n +3'],
    { timeoutMs: 60_000, env: { PATTERN: pattern }, onLine: (line) => {
      const name = line.trim();
      if (name.endsWith('.tar.gz')) stale.push(name);
    } },
  ).catch(() => {});
  for (const file of stale) {
    await runDocker(
      ['run', '--rm', '-v', `${BACKUP_VOLUME}:/backup`, 'alpine', 'sh', '-c', 'rm -f "/backup/$FILE"'],
      { timeoutMs: 60_000, env: { FILE: file } },
    ).catch(() => {});
  }
  return stale;
}
