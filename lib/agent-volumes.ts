/**
 * Agent data volumes: the name an agent's volume has, which volumes may be offered for deletion,
 * and how long a create waits for the Gateway. Pure functions, no Docker calls (the Docker side is
 * lib/agent-volumes-server.ts), so tests can run them without a daemon.
 *
 * Every agent keeps its data (`/root`) in one named volume, `agent-<container>-data`
 * (lib/agent-create-args.ts). A create that fails after `docker run` used to remove the container
 * and leave the volume (~570 MB each) behind.
 */

/** Readiness window of a create on a native image. */
export const NATIVE_READY_TIMEOUT_MS = 120_000;

/** Readiness window when the image runs under emulation: a first boot is several times slower. */
export const EMULATED_READY_TIMEOUT_MS = 300_000;

/** The only volume names the orphan list shows and the delete route accepts. */
const AGENT_VOLUME_RE = /^agent-[a-zA-Z0-9][a-zA-Z0-9._-]*-data$/;

/** The data volume of an agent container. */
export function agentVolumeName(container: string): string {
  return `agent-${container}-data`;
}

/** True for `agent-<something>-data`. Never true for `rev4a-*` or any other volume. */
export function isAgentVolumeName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 128 && AGENT_VOLUME_RE.test(name);
}

/** Docker (`x86_64`, `aarch64`) and image (`amd64`, `arm64`) spellings of one architecture, as one. */
export function normalizeArch(arch: unknown): string | null {
  if (typeof arch !== 'string') return null;
  const a = arch.trim().toLowerCase();
  if (!a) return null;
  if (a === 'x86_64' || a === 'x86-64' || a === 'amd64') return 'amd64';
  if (a === 'aarch64' || a === 'arm64' || a === 'arm64/v8') return 'arm64';
  return a;
}

/** True when the image's architecture is known, the host's is known, and they differ (the image is emulated). */
export function isEmulated(imageArch: unknown, hostArch: unknown): boolean {
  const i = normalizeArch(imageArch);
  const h = normalizeArch(hostArch);
  return i !== null && h !== null && i !== h;
}

/** How long a create waits for the Gateway: 300 s under emulation, 120 s otherwise (or when unknown). */
export function readyTimeoutMs(imageArch: unknown, hostArch: unknown): number {
  return isEmulated(imageArch, hostArch) ? EMULATED_READY_TIMEOUT_MS : NATIVE_READY_TIMEOUT_MS;
}

/** A volume as `GET /volumes` and `GET /system/df` report it. */
export interface DockerVolume {
  Name?: string;
  CreatedAt?: string;
  UsageData?: { Size?: number; RefCount?: number } | null;
}

/** A container as `GET /containers/json?all=1` reports it. */
export interface DockerContainerMounts {
  Mounts?: { Type?: string; Name?: string }[] | null;
}

export interface OrphanVolume {
  /** Set when Delete is not offered; says why. */
  keptReason?: string;
  name: string;
  /** Bytes, or null when Docker has not measured it. */
  sizeBytes: number | null;
  /** ISO time from Docker, or null. */
  createdAt: string | null;
}

/** Names of the volumes mounted by at least one container, in any state. */
export function usedVolumeNames(containers: readonly DockerContainerMounts[]): Set<string> {
  const used = new Set<string>();
  for (const c of containers) {
    for (const m of c.Mounts ?? []) {
      if (m && m.Type === 'volume' && typeof m.Name === 'string') used.add(m.Name);
    }
  }
  return used;
}

/**
 * The `agent-*-data` volumes no container uses, newest first. Anything else (`rev4a-*`, other
 * projects' volumes, an agent volume a container still mounts) is never listed.
 */
export function findOrphanVolumes(
  volumes: readonly DockerVolume[],
  containers: readonly DockerContainerMounts[],
): OrphanVolume[] {
  const used = usedVolumeNames(containers);
  const out: OrphanVolume[] = [];
  for (const v of volumes) {
    const name = v?.Name;
    if (!isAgentVolumeName(name) || used.has(name)) continue;
    const size = v.UsageData?.Size;
    out.push({
      name,
      sizeBytes: typeof size === 'number' && size >= 0 ? size : null,
      createdAt: typeof v.CreatedAt === 'string' && v.CreatedAt ? v.CreatedAt : null,
    });
  }
  return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.name.localeCompare(b.name));
}

/** The agent id inside `agent-<id>-data`, or null when the name is not an agent volume name. */
export function agentIdFromVolumeName(name: unknown): string | null {
  if (!isAgentVolumeName(name)) return null;
  return name.slice('agent-'.length, -'-data'.length);
}

export const UNFINISHED_KEPT_REASON = 'Kept: the last recreate, update or edit of this agent did not finish, so this volume may hold its only copy of the data. If the agent is truly gone, remove it by hand with docker volume rm.';

/**
 * Whether an orphan-looking volume must be left alone.
 * - `busy`: the agent is in a long operation (recreate, update, restore, edit, backup): between the
 *   old container's removal and the new one's start its live volume has no container.
 * - a recreate that is not `done`, or an update that is neither `done`, `rolled_back` nor proved fine
 *   (`updateResolved`), may have left the agent's data only here.
 * Returns `'busy'` (leave out entirely), a reason to show instead of a Delete button, or null.
 */
export function volumeKeepDecision(p: {
  busy: boolean;
  recreateStatus: string | null;
  updateStatus: string | null;
  updateResolved?: boolean;
  /** An edit rebuilds the container too (agent-edit.ts → recreateAgentContainer): a failed or cut-off one can leave no container. */
  editStatus?: string | null;
}): 'busy' | string | null {
  if (p.busy) return 'busy';
  if (p.recreateStatus !== null && p.recreateStatus !== 'done') return UNFINISHED_KEPT_REASON;
  if (p.editStatus === 'failed' || p.editStatus === 'interrupted') return UNFINISHED_KEPT_REASON;
  if (p.updateStatus !== null && p.updateStatus !== 'done' && p.updateStatus !== 'rolled_back' && !p.updateResolved) {
    return UNFINISHED_KEPT_REASON;
  }
  return null;
}
