/**
 * Docker side of the agent data volumes (names and rules: lib/agent-volumes.ts).
 *
 * - `volumeExists` / `removeVolume`: what a failed create uses to leave nothing behind.
 * - `listOrphanVolumes` / `deleteOrphanVolume`: the System page's list of `agent-*-data` volumes no
 *   container uses. Nothing here deletes by itself; the delete route runs on a click.
 *
 * "No container uses it" is not enough: a recreate, update, rollback or edit removes the old container
 * before it starts the new one, and a failed recreate leaves the data only in the volume. So a volume
 * whose agent is busy is left out, one whose last recreate/update did not finish is listed as kept,
 * and the busy check is the last thing before `docker volume rm`.
 *
 * Sizes come from `GET /system/df?type=volume` (the only call that measures volumes; it works the
 * same on Docker Desktop and Linux, and takes seconds on a big host), so the volume list is cached for
 * 5 minutes and one in-flight read is shared. Which containers use a volume is never cached.
 */
import { execFileSync } from 'child_process';
import { dockerRequestJson } from '@/lib/docker-socket-path';
import { runDocker } from '@/lib/agent-images';
import { agentBusyReason } from '@/lib/agent-busy';
import { latestRecreate } from '@/lib/agent-recreate-state';
import { latestUpdate } from '@/lib/agent-update-state';
import { latestEdit } from '@/lib/agent-edit-state';
import { isValidAgentId } from '@/lib/container';
import {
  agentIdFromVolumeName,
  findOrphanVolumes,
  isAgentVolumeName,
  usedVolumeNames,
  volumeKeepDecision,
  type DockerContainerMounts,
  type DockerVolume,
  type OrphanVolume,
} from '@/lib/agent-volumes';

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound on every Docker read here, so a slow daemon never hangs a route or a rollback. */
export const DOCKER_READ_TIMEOUT_MS = 10_000;

let cache: { at: number; volumes: DockerVolume[] } | null = null;
let inflight: Promise<DockerVolume[]> | null = null;
/** Bumped by an invalidation: a read that started before it must not store its (older) answer. */
let generation = 0;

/** Forget the cached volume list, so the next read asks Docker again (a rollback that kept a volume, for one). */
export function invalidateVolumesCache(): void {
  cache = null;
  inflight = null;
  generation++;
}

/** GET against the Docker API with the shared timeout. */
export function dockerGet<T>(apiPath: string): Promise<T> {
  return dockerRequestJson<T>('GET', apiPath, DOCKER_READ_TIMEOUT_MS);
}

/**
 * Whether the volume exists. When Docker cannot answer this returns true: the caller only deletes a
 * volume it knows it created, so "unknown" must read as "not ours to delete".
 */
export function volumeExists(name: string): boolean {
  try {
    const out = execFileSync('docker', ['volume', 'ls', '-q', '--filter', `name=^${name}$`], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').some((l) => l.trim() === name);
  } catch {
    return true;
  }
}

/** `docker volume rm -f`; true when the volume is gone afterwards. Never throws. */
export function removeVolume(name: string): boolean {
  try {
    execFileSync('docker', ['volume', 'rm', '-f', name], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function allContainers(): Promise<DockerContainerMounts[]> {
  const list = await dockerGet<DockerContainerMounts[]>('/containers/json?all=1');
  return Array.isArray(list) ? list : [];
}

function loadVolumes(): Promise<DockerVolume[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.volumes);
  if (inflight) return inflight;
  const started = generation;
  const read: Promise<DockerVolume[]> = dockerGet<{ Volumes?: DockerVolume[] | null }>('/system/df?type=volume')
    .then((df) => {
      const volumes = Array.isArray(df?.Volumes) ? df.Volumes : [];
      if (started === generation) cache = { at: Date.now(), volumes };
      return volumes;
    })
    .finally(() => { if (inflight === read) inflight = null; });
  inflight = read;
  return read;
}

/** `'busy'`, a reason to keep it, or null. Fails closed: an unreadable state keeps the volume. */
async function keepDecision(name: string): Promise<'busy' | string | null> {
  const id = agentIdFromVolumeName(name);
  if (id === null || !isValidAgentId(id)) return 'busy';
  try {
    const busy = (await agentBusyReason(id)) !== null;
    const recreate = latestRecreate(id);
    const update = latestUpdate(id);
    return volumeKeepDecision({
      busy,
      recreateStatus: recreate?.status ?? null,
      updateStatus: update?.status ?? null,
      updateResolved: !!update?.resolved_at,
      editStatus: latestEdit(id)?.status ?? null,
    });
  } catch {
    return 'busy';
  }
}

/** `agent-*-data` volumes with no container (any state) and no agent operation touching them. */
export async function listOrphanVolumes(): Promise<OrphanVolume[]> {
  const [volumes, containers] = await Promise.all([loadVolumes(), allContainers()]);
  const out: OrphanVolume[] = [];
  for (const v of findOrphanVolumes(volumes, containers)) {
    const d = await keepDecision(v.name);
    if (d === 'busy') continue;
    out.push(d === null ? v : { ...v, keptReason: d });
  }
  return out;
}

export type DeleteOrphanResult = 'deleted' | 'invalid' | 'in_use' | 'busy' | 'kept' | 'not_found';

/**
 * Remove one orphan volume. The name is validated, the containers are read again (a volume a
 * container mounts, even a stopped one, is refused), the volume must exist, and the agent's busy
 * state is checked last, right before `docker volume rm`.
 */
export async function deleteOrphanVolume(name: string): Promise<DeleteOrphanResult> {
  if (!isAgentVolumeName(name)) return 'invalid';
  if (usedVolumeNames(await allContainers()).has(name)) return 'in_use';
  try {
    await dockerGet(`/volumes/${encodeURIComponent(name)}`);
  } catch (e) {
    if (/Docker error 404/.test((e as Error).message)) return 'not_found';
    throw e;
  }
  const d = await keepDecision(name);
  if (d === 'busy') return 'busy';
  if (d !== null) return 'kept';
  // No -f: docker itself refuses a volume that became used in the meantime.
  await runDocker(['volume', 'rm', name], { timeoutMs: 60_000 });
  cache = null;
  return 'deleted';
}
