/**
 * Agent base images: the OpenClaw versions downloaded here, the agents using each,
 * the supported versions the registry publishes, and pulling one.
 *
 * Images are addressed by version tag, `openclaw-agent-base:<version>`, never by
 * `:latest`. An agent's OpenClaw version decides its data schema, and a moving shared
 * tag would move every new or recreated agent with it. Create uses the newest
 * supported version downloaded; recreate keeps the agent's own version.
 */
import { spawn } from 'child_process';
import { dockerFetch } from '@/lib/docker-socket';
import { dockerExecNoFail } from '@/lib/docker-exec';
import {
  LOCAL_IMAGE_REPOSITORY,
  compareVersions,
  isSupportedVersion,
  localImageRef,
  parseOpenClawVersion,
  registryRepository,
} from '@/lib/agent-versions';

const VERSION_LABEL = 'org.opencontainers.image.version';
const REMOTE_TTL_MS = 10 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 10_000;
const PULL_TIMEOUT_MS = 30 * 60 * 1000;

export interface LocalAgentImage {
  id: string;
  tags: string[];
  /** From the version label, else from a version tag; null for an unlabelled, untagged image. */
  version: string | null;
  sizeBytes: number;
  /** AGENT_ID of every container, running or stopped, created from this image. */
  usedBy: string[];
}

interface DockerImage {
  Id: string;
  RepoTags?: string[] | null;
  Labels?: Record<string, string> | null;
  Size?: number;
}

interface DockerContainer {
  ImageID?: string;
  Labels?: Record<string, string> | null;
}

const tagPrefix = `${LOCAL_IMAGE_REPOSITORY}:`;

function versionFromTags(tags: string[]): string | null {
  for (const tag of tags) {
    if (!tag.startsWith(tagPrefix)) continue;
    const version = parseOpenClawVersion(tag.slice(tagPrefix.length));
    if (version) return version;
  }
  return null;
}

/** Local `openclaw-agent-base` images, through the Docker API. */
export async function listLocalAgentImages(): Promise<LocalAgentImage[]> {
  const imageFilter = encodeURIComponent(JSON.stringify({ reference: [LOCAL_IMAGE_REPOSITORY] }));
  const agentFilter = encodeURIComponent(JSON.stringify({ label: ['AGENT_ID'] }));
  const [images, containers] = await Promise.all([
    dockerFetch<DockerImage[]>('GET', `/images/json?filters=${imageFilter}`),
    dockerFetch<DockerContainer[]>('GET', `/containers/json?all=true&filters=${agentFilter}`),
  ]);

  const usedBy = new Map<string, string[]>();
  for (const c of Array.isArray(containers) ? containers : []) {
    const agentId = c.Labels?.AGENT_ID;
    if (!c.ImageID || !agentId) continue;
    usedBy.set(c.ImageID, [...(usedBy.get(c.ImageID) ?? []), agentId]);
  }

  return (Array.isArray(images) ? images : []).map((img) => {
    const tags = (img.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
    return {
      id: img.Id,
      tags,
      version: parseOpenClawVersion(img.Labels?.[VERSION_LABEL]) ?? versionFromTags(tags),
      sizeBytes: img.Size ?? 0,
      usedBy: usedBy.get(img.Id) ?? [],
    };
  });
}

/** Supported versions present locally under their version tag, newest first. */
export function localSupportedVersions(images: LocalAgentImage[]): string[] {
  const versions = new Set<string>();
  for (const img of images) {
    for (const tag of img.tags) {
      if (tag.startsWith(tagPrefix) && isSupportedVersion(tag.slice(tagPrefix.length))) {
        versions.add(tag.slice(tagPrefix.length));
      }
    }
  }
  return [...versions].sort((a, b) => compareVersions(b, a));
}

export const newestLocalSupportedVersion = (images: LocalAgentImage[]): string | null =>
  localSupportedVersions(images)[0] ?? null;

/**
 * Whether an image reference (a tag or an id) exists locally. `dockerFetch` resolves
 * Docker's error bodies too, so a 404 is told apart by the missing `Id`.
 */
async function imageExists(reference: string): Promise<boolean> {
  try {
    const info = await dockerFetch<{ Id?: unknown }>('GET', `/images/${encodeURIComponent(reference)}/json`);
    return typeof info?.Id === 'string';
  } catch {
    return false;
  }
}

/** Whether `openclaw-agent-base:<version>` exists locally. */
export const localVersionExists = (version: string): Promise<boolean> => imageExists(localImageRef(version));

/**
 * Versions read from inside containers, keyed by image id: an image never changes
 * version. A failed read is remembered for a few minutes too, so a container whose
 * image is not OpenClaw does not cost a `docker exec` on every agent list poll.
 */
const versionByImageId = new Map<string, { version: string | null; at: number }>();
const UNKNOWN_VERSION_TTL_MS = 5 * 60 * 1000;

/**
 * The OpenClaw version a container runs: its image's label or version tag, else
 * `openclaw --version` inside the running container, for images built before the
 * label existed (a release published as `:latest` only). Null for a stopped container
 * whose image carries neither.
 */
export async function containerOpenClawVersion(
  container: { name: string; imageId: string; running: boolean },
  images: LocalAgentImage[],
): Promise<string | null> {
  const fromImage = images.find((img) => img.id === container.imageId)?.version;
  if (fromImage) return fromImage;
  const cached = versionByImageId.get(container.imageId);
  if (cached && (cached.version || Date.now() - cached.at < UNKNOWN_VERSION_TTL_MS)) return cached.version;
  if (!container.running) return null;
  const version = parseOpenClawVersion(
    await dockerExecNoFail(container.name, ['openclaw', '--version'], { timeoutMs: 30_000 }),
  );
  versionByImageId.set(container.imageId, { version, at: Date.now() });
  return version;
}

// ── Registry ─────────────────────────────────────────────────────────────────

function splitRepository(repository: string): { host: string; path: string } {
  const [first, ...rest] = repository.split('/');
  if (rest.length && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    return { host: first, path: rest.join('/') };
  }
  return { host: 'registry-1.docker.io', path: repository.includes('/') ? repository : `library/${repository}` };
}

const isLocalRegistryHost = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

/**
 * Tags of a repository through the registry HTTP API. A public registry such as ghcr
 * answers 401 with a Bearer challenge; an anonymous token for `pull` is then fetched
 * from the realm it names. A registry on localhost is plain HTTP.
 */
async function fetchRegistryTags(repository: string): Promise<string[]> {
  const { host, path } = splitRepository(repository);
  const url = `${isLocalRegistryHost(host) ? 'http' : 'https'}://${host}/v2/${path}/tags/list?n=1000`;
  const get = (target: string | URL, headers?: Record<string, string>) =>
    fetch(target, { headers, cache: 'no-store', signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });

  let res = await get(url);
  if (res.status === 401) {
    const challenge = res.headers.get('www-authenticate') ?? '';
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!params.realm) throw new Error('the registry asked for credentials');
    const tokenUrl = new URL(params.realm);
    if (params.service) tokenUrl.searchParams.set('service', params.service);
    tokenUrl.searchParams.set('scope', params.scope ?? `repository:${path}:pull`);
    const tokenRes = await get(tokenUrl);
    if (!tokenRes.ok) throw new Error(`registry token request failed (HTTP ${tokenRes.status})`);
    const body = (await tokenRes.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new Error('the registry returned no token');
    res = await get(url, { Authorization: `Bearer ${token}` });
  }
  if (!res.ok) throw new Error(`registry tag list failed (HTTP ${res.status})`);
  return ((await res.json()) as { tags?: string[] | null }).tags ?? [];
}

let remoteCache: { repository: string; versions: string[] | null; at: number } | null = null;
let remoteInFlight: Promise<string[] | null> | null = null;

/**
 * Supported versions the registry publishes, newest first; null when it cannot be
 * reached. Cached for ten minutes, and concurrent callers share one lookup, so a
 * banner polling every two seconds costs one request per TTL.
 */
export async function remoteSupportedVersions(): Promise<string[] | null> {
  const repository = registryRepository();
  if (remoteCache && remoteCache.repository === repository && Date.now() - remoteCache.at < REMOTE_TTL_MS) {
    return remoteCache.versions;
  }
  if (remoteInFlight) return remoteInFlight;

  remoteInFlight = (async () => {
    try {
      const tags = await fetchRegistryTags(repository);
      return tags.filter(isSupportedVersion).sort((a, b) => compareVersions(b, a));
    } catch {
      return null;
    }
  })();
  try {
    const versions = await remoteInFlight;
    remoteCache = { repository, versions, at: Date.now() };
    return versions;
  } finally {
    remoteInFlight = null;
  }
}

// ── Pull ─────────────────────────────────────────────────────────────────────

/**
 * Runs `docker <args>`, streaming output lines; rejects with the last error line.
 *
 * A signal that is already aborted rejects before anything is spawned: an `abort`
 * listener added to an aborted signal never fires, so the process would otherwise run
 * to completion even though its caller has been cancelled.
 *
 * Lines are reassembled across output chunks — a chunk can end mid-line — and `\r` is
 * treated as a line break too, since docker redraws progress with it.
 *
 * `env` is for container environment on `docker run`: each name is inserted as `-e KEY`
 * right after the subcommand, and the value reaches docker through its own
 * environment, so secrets stay out of the process table.
 */
export function runDocker(
  args: string[],
  opts: { onLine?: (line: string) => void; signal?: AbortSignal; timeoutMs: number; env?: Record<string, string> },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error(`docker ${args[0]} aborted`));
      return;
    }
    const envNames = Object.keys(opts.env ?? {});
    const argv = envNames.length ? [args[0], ...envNames.flatMap((k) => ['-e', k]), ...args.slice(1)] : args;
    const child = spawn('docker', argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(envNames.length ? { env: { ...process.env, ...opts.env } } : {}),
    });
    let lastError = '';
    let firstError = '';
    const emit = (line: string, isErr: boolean) => {
      if (!line.trim()) return;
      if (isErr) {
        // Docker prints the cause first and "Run 'docker run --help' …" last; keep
        // both ends so the rejection can carry the cause, not the usage pointer.
        firstError ||= line.trim();
        lastError = line.trim();
      }
      opts.onLine?.(line);
    };
    // The unfinished tail of the last chunk, per stream, completed by the next one.
    const pending = { out: '', err: '' };
    const onData = (isErr: boolean) => (chunk: Buffer) => {
      const key = isErr ? 'err' : 'out';
      const parts = (pending[key] + chunk.toString()).split(/\r\n|\n|\r/);
      pending[key] = parts.pop() ?? '';
      for (const line of parts) emit(line, isErr);
    };
    const flush = () => {
      emit(pending.out, false);
      emit(pending.err, true);
      pending.out = pending.err = '';
    };
    child.stdout.on('data', onData(false));
    child.stderr.on('data', onData(true));

    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      kill();
      reject(new Error(`docker ${args[0]} timed out`));
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      reject(err);
    });
    child.on('close', (code) => {
      flush();
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      if (code === 0) resolve();
      else reject(new Error(firstError && firstError !== lastError ? `${firstError} (${lastError})` : lastError || `docker ${args[0]} exited with code ${code}`));
    });
  });
}

/**
 * Pull `<registry>:<version>` and tag it `openclaw-agent-base:<version>`. The registry
 * reference is removed afterwards, so local images list under the version tag only: after
 * a successful tag that is an untag (the layers stay); when the tag failed or was
 * cancelled it is the image's only name, and the pulled image is deleted with it.
 */
export async function pullAgentImage(
  version: string,
  opts: { onLine?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<void> {
  if (!isSupportedVersion(version)) throw new Error(`OpenClaw ${version} is not supported by this Rev4a`);
  const remote = `${registryRepository()}:${version}`;
  await runDocker(['pull', remote], { ...opts, timeoutMs: PULL_TIMEOUT_MS });
  try {
    await runDocker(['tag', remote, localImageRef(version)], { ...opts, timeoutMs: 30_000 });
  } finally {
    // Also when the tag failed or was cancelled: left behind, the registry reference
    // is a full image under a name neither the listing nor retention looks at.
    await runDocker(['rmi', remote], { timeoutMs: 30_000 }).catch(() => {});
  }
}

/**
 * Retention: remove agent images nothing needs.
 *
 * Kept: every image a container uses, running or stopped, and the newest and the
 * previous OpenClaw version present — the previous one is what a rollback runs. Other
 * images lose all their tags. A kept image loses its extra tags (`latest`,
 * `2026.9.3-local`) when it has a version tag. Nothing is forced: Docker refuses to
 * remove an image a container uses, the last safety net. A removed version can be
 * pulled again while the registry publishes it. Returns the references removed.
 */
export async function pruneAgentImages(): Promise<string[]> {
  const images = await listLocalAgentImages();
  const versions = [...new Set(images.map((img) => img.version).filter((v): v is string => !!v))]
    .sort((a, b) => compareVersions(b, a));
  const keepVersions = new Set(versions.slice(0, 2));

  const removed: string[] = [];
  for (const img of images) {
    const keep = img.usedBy.length > 0 || (img.version !== null && keepVersions.has(img.version));
    const versionTags = img.tags.filter((t) => {
      if (!t.startsWith(tagPrefix)) return false;
      const tag = t.slice(tagPrefix.length);
      return parseOpenClawVersion(tag) === tag;
    });
    const targets = keep ? (versionTags.length ? img.tags.filter((t) => !versionTags.includes(t)) : []) : img.tags;
    for (const tag of targets) {
      try {
        await runDocker(['rmi', tag], { timeoutMs: 120_000 });
        removed.push(tag);
      } catch {
        // In use, or already gone.
      }
    }
  }
  return removed;
}

/**
 * The image a recreate uses: the agent's own OpenClaw version under its version tag.
 * A recreate never changes version.
 *
 * When the tag is missing but the container's image is still here (an agent created
 * from `:latest` before version tags), that image gets the version tag. When the image
 * is gone too, a supported version is pulled. An agent whose version cannot be read
 * keeps the exact image id it runs.
 */
export async function resolveRecreateImage(container: {
  Name?: string;
  Image?: string;
  Config?: { Image?: string };
  State?: { Running?: boolean };
}): Promise<string> {
  const name = (container.Name ?? '').replace(/^\//, '');
  const imageId = container.Image ?? '';
  const images = await listLocalAgentImages();
  const version = await containerOpenClawVersion(
    { name, imageId, running: container.State?.Running === true },
    images,
  );

  if (version) {
    const ref = localImageRef(version);
    if (await localVersionExists(version)) return ref;
    if (imageId && (await imageExists(imageId))) {
      await runDocker(['tag', imageId, ref], { timeoutMs: 30_000 });
      return ref;
    }
    if (isSupportedVersion(version)) {
      await pullAgentImage(version);
      return ref;
    }
    throw new Error(`The image for OpenClaw ${version} is not available locally`);
  }

  if (imageId && (await imageExists(imageId))) return imageId;
  if (container.Config?.Image) return container.Config.Image;
  throw new Error('Cannot tell which image this agent runs');
}
