/**
 * Editing an agent's display name and/or port range.
 *
 * The container is rebuilt on the current build of its image's OpenClaw version
 * (a newer build if one was downloaded), or its exact image id when the image has no
 * version label or tag, with the new environment value (`AGENT_NAME`) and/or port
 * bindings — no cold backup, because the persistent volume is
 * never touched. The job is recorded in `agent_edits` and runs in the background, so a
 * page reload or a Rev4a restart never loses track of it and a second edit (or a backup)
 * cannot start on top of the first (lib/agent-busy.ts answers 409 while one runs).
 */
import { isValidAgentId } from '@/lib/container';
import { hostPortsFromBindings, portMappingArgs, validatePortInput } from '@/lib/agent-ports';
import { agentPortsHostIp, getUsedHostPorts } from '@/lib/agent-ports-server';
import { resolveRecreateImage } from '@/lib/agent-images';
import { inspectAgentContainer, recreateAgentContainer, startAndVerifyContainer } from '@/lib/agent-recreate';
import { agentBusyReason } from '@/lib/agent-busy';
import { waitForGatewayReady } from '@/lib/agent-readiness';
import { applyRuntimeConfig } from '@/lib/agent-setup';
import { patchRev4aProvider } from '@/app/api/gateway/sync';
import { activeEditAgentIds, insertEdit, isEditActive, latestEdit, markInterruptedEdits, updateEditRow, type AgentEditRow } from '@/lib/agent-edit-state';

const EDIT_READY_TIMEOUT_MS = 5 * 60 * 1000;

export class EditRefusedError extends Error {}

/**
 * Port bindings for a range, validated with the same rules and messages as agent
 * creation. `ownPorts` are the agent's own published host ports: they are excluded from
 * the "already in use" check, so keeping or shifting its own block is not a conflict
 * with itself — while a conflict with another agent still fails **before** the container
 * is removed.
 */
async function parsePortArgs(portRange: string, ownPorts: number[]): Promise<string[]> {
  const used = await getUsedHostPorts();
  for (const p of ownPorts) used.delete(p);
  const result = validatePortInput(portRange, used);
  if (!result.valid) throw new EditRefusedError(result.error);
  return portMappingArgs(result.start, result.end, agentPortsHostIp());
}

/** Edit jobs running in this process, so a second start for the same agent is refused. */
const running = new Set<string>();

export interface EditOptions {
  displayName?: string;
  portRange?: string;
  /** Rebuild the container without its memory limit (`docker update` cannot remove one). */
  removeMemoryLimit?: boolean;
}

/** Start an edit. Returns once the job is recorded; the rebuild continues in the background. */
export async function startAgentEdit(agentId: string, opts: EditOptions): Promise<number> {
  if (!isValidAgentId(agentId)) throw new EditRefusedError('Invalid agent id');

  const displayName = opts.displayName === undefined ? undefined : (opts.displayName.trim() || null);
  if (opts.displayName !== undefined && !displayName) throw new EditRefusedError('Display name must not be empty');
  if (!displayName && !opts.portRange && !opts.removeMemoryLimit) throw new EditRefusedError('No fields to update');
  const portRange = opts.portRange?.trim() || null;

  if (running.has(agentId) || isEditActive(agentId)) throw new EditRefusedError('An edit of this agent is already running');
  // Claimed synchronously, before the first await, so two requests cannot both pass.
  running.add(agentId);
  try {
    // One source for every long operation: an update, recreate, restore, edit or backup.
    const busy = await agentBusyReason(agentId);
    if (busy) throw new EditRefusedError(busy);

    const container = await inspectAgentContainer(agentId);
    if (!container) throw new EditRefusedError(`No container found with AGENT_ID '${agentId}'`);
    // A bad range is refused before any state is written, and before the container is
    // removed — the only failure mode that could leave the agent without one.
    const portArgs = opts.portRange ? await parsePortArgs(opts.portRange, hostPortsFromBindings(container)) : undefined;

    const id = insertEdit(agentId, displayName ?? null, portRange, !!opts.removeMemoryLimit);
    void runEdit(id, agentId, container, displayName ?? null, portArgs, !!opts.removeMemoryLimit).finally(() => running.delete(agentId));
    return id;
  } catch (e) {
    running.delete(agentId);
    if (e && typeof e === 'object' && (e as { code?: unknown }).code === 'REV4A_AGENT_JOB_BUSY') {
      throw new EditRefusedError((e as Error).message);
    }
    throw e;
  }
}

async function runEdit(id: number, agentId: string, container: Awaited<ReturnType<typeof inspectAgentContainer>>, displayName: string | null, portArgs?: string[], removeMemoryLimit = false): Promise<void> {
  let warning: string | null = null;
  try {
    if (!container) throw new Error(`No container found with AGENT_ID '${agentId}'`);
    const image = await resolveRecreateImage(container);

    await recreateAgentContainer(agentId, container, image, {
      env: displayName ? { AGENT_NAME: displayName } : undefined,
      portArgs,
      // null rebuilds without any memory flag; undefined carries the container's own limit.
      memoryLimitMb: removeMemoryLimit ? null : undefined,
      gracefulStop: true,
      onWarning: (message) => { warning = message; updateEditRow(id, { error: message }); },
    });

    if (!(await waitForGatewayReady(agentId, EDIT_READY_TIMEOUT_MS))) {
      throw new Error(`The gateway did not finish starting within ${EDIT_READY_TIMEOUT_MS / 60_000} minutes`);
    }
    await applyRuntimeConfig(agentId);
    try {
      await patchRev4aProvider(agentId);
    } catch (e) {
      console.error('[agent:edit] provider patch failed:', (e as Error).message);
    }

    updateEditRow(id, { status: 'done', error: warning });
  } catch (e) {
    updateEditRow(id, { status: 'failed', error: [(e as Error)?.message ?? String(e), warning].filter(Boolean).join('; ') });
  }
}

export interface AgentEditView {
  id: number;
  agentId: string;
  status: AgentEditRow['status'];
  displayName: string | null;
  portRange: string | null;
  memoryLimitRemoved: boolean;
  error: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

/** The latest edit of an agent, so the panel can resume after a reload. */
export function agentEditView(agentId: string): AgentEditView | null {
  const row = latestEdit(agentId);
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    displayName: row.display_name,
    portRange: row.port_range,
    memoryLimitRemoved: row.memory_limit_removed === 1,
    error: row.error,
    startedAtMs: row.started_at,
    finishedAtMs: row.finished_at,
  };
}

/**
 * At startup no edit job can be running: rows still active were cut off by the restart.
 * They become `interrupted`; a container left stopped is started again, best-effort.
 */
export async function recoverInterruptedEdits(): Promise<number> {
  const ids = activeEditAgentIds();
  if (ids.size === 0) return 0;
  const interrupted = markInterruptedEdits();
  for (const agentId of ids) {
    const container = await inspectAgentContainer(agentId).catch(() => null);
    const name = container?.Name?.replace(/^\//, '');
    if (!name || container?.State?.Running) continue;
    const started = await startAndVerifyContainer(agentId, name);
    if (!started.ok) console.warn(`[agent:edit] ${agentId} did not come back after an interrupted edit: ${started.error}`);
  }
  return interrupted;
}
