/**
 * buildAgentImage.ts
 *
 * Shared logic for obtaining the openclaw-agent-base Docker image.
 * Used by /api/setup/agent-image, /api/agents/rebuild-image, and
 * the olympus serve CLI.
 *
 * Strategy (in order):
 *   1. docker pull from ghcr.io/flame0510/openclaw-agent-base:latest (public, no auth)
 *   2. If pull fails (offline / no network) → fallback to local docker build
 *
 * Logs are written to /tmp/olympus-build-<timestamp>.log so they survive
 * page refreshes and modal closes.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync as execSyncRaw } from 'child_process';

const REGISTRY_IMAGE = 'ghcr.io/flame0510/openclaw-agent-base:latest';
const LOCAL_IMAGE = 'openclaw-agent-base:latest';

let isPulling = false;
let buildLogPath: string | null = null;
let pullChildProcess: ReturnType<(typeof import('child_process'))['exec']> | null = null;

/** Check whether the docker CLI is available and functional. */
function dockerAvailable(): boolean {
  try {
    execSyncRaw('docker version --format "{{.Client.Version}}" 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Returns the SHA256 hash of the current Dockerfile. */
export function getDockerfileHash(): string | null {
  try {
    const dockerfile = path.join(process.cwd(), 'agent-templates', 'base-image', 'Dockerfile');
    if (!fs.existsSync(dockerfile)) return null;
    const content = fs.readFileSync(dockerfile, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/** Returns the path to the current (or most recent) build log file. */
export function getBuildLogPath(): string | null {
  return buildLogPath;
}

/** Checks if a pull/build process is already running. */
export function getIsBuilding(): boolean {
  if (isPulling) return true;
  try {
    const out = execSyncRaw(
      'ps aux | grep -E "[d]ocker.*(pull|build).*openclaw-agent-base"',
      { encoding: 'utf-8', timeout: 2000 },
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Acquire the lock atomically. Returns false if already locked. */
function tryAcquireLock(): boolean {
  if (getIsBuilding()) return false;
  isPulling = true;
  return true;
}

/** Release the lock and clear state. */
function releaseLock(): void {
  isPulling = false;
  buildLogPath = null;
  pullChildProcess = null;
}

/**
 * Abort an in-progress pull/build by killing the docker process.
 */
export function abortBuild(): boolean {
  if (!isPulling || !pullChildProcess) return false;
  try {
    appendLog('');
    appendLog('=== Operation aborted by user ===');
    pullChildProcess.kill('SIGTERM');
    try {
      execSyncRaw("pkill -f 'docker.*(pull|build).*openclaw-agent-base' || true", { timeout: 2000 });
    } catch { /* ok */ }
    releaseLock();
    return true;
  } catch {
    return false;
  }
}

function appendLog(msg: string): void {
  if (!buildLogPath) return;
  try {
    fs.appendFileSync(buildLogPath, msg + '\n', 'utf-8');
  } catch { /* ignore */ }
}

export interface BuildOptions {
  force?: boolean;
  onEvent?: (data: string) => void;
  signal?: AbortSignal;
}

function localImageExists(): boolean {
  if (!dockerAvailable()) return false;
  try {
    execSyncRaw(
      `docker image inspect ${LOCAL_IMAGE} --format "{{.ID}}" 2>/dev/null`,
      { timeout: 3000 },
    );
    return true;
  } catch {
    return false;
  }
}

function getLocalImageId(): string | null {
  if (!dockerAvailable()) return null;
  try {
    return execSyncRaw(
      `docker image inspect ${LOCAL_IMAGE} --format "{{.ID}}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the digest of the remote image (without pulling).
 * Returns null if not reachable.
 */
function getRemoteDigest(): string | null {
  if (!dockerAvailable()) return null;
  try {
    // docker manifest inspect works without pulling the image
    const out = execSyncRaw(
      `docker manifest inspect ${REGISTRY_IMAGE} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    const manifest = JSON.parse(out);
    // Return the config digest as the image identity
    return manifest?.config?.digest || null;
  } catch {
    return null;
  }
}

/**
 * Pull the image from the public registry and tag it locally.
 */
async function pullFromRegistry(
  opts: BuildOptions,
  emit: (data: string) => void,
): Promise<boolean> {
  if (!dockerAvailable()) {
    emit(JSON.stringify({ type: 'error', message: 'Docker is not available' }));
    appendLog('Docker not available — cannot pull image');
    return false;
  }

  emit(JSON.stringify({ type: 'status', message: `Pulling ${REGISTRY_IMAGE}...` }));
  appendLog(`Pulling from registry: ${REGISTRY_IMAGE}`);

  try {
    execSyncRaw(`docker pull ${REGISTRY_IMAGE}`, {
      stdio: 'inherit',
      timeout: 300_000, // 5 min
    });
    execSyncRaw(`docker tag ${REGISTRY_IMAGE} ${LOCAL_IMAGE}`, {
      timeout: 10_000,
    });
    appendLog('Pull completed successfully');
    emit(JSON.stringify({ type: 'complete', message: 'Image pulled from registry' }));
    return true;
  } catch {
    appendLog('Pull from registry failed');
    emit(JSON.stringify({ type: 'log', message: 'Registry pull failed, trying local build...' }));
    return false;
  }
}

/**
 * Local docker build fallback.
 */
function localBuild(
  opts: BuildOptions,
  emit: (data: string) => void,
  resolve: () => void,
  reject: (err: Error) => void,
): void {
  const dockerfileDir = path.join(process.cwd(), 'agent-templates', 'base-image');
  const dockerfile = path.join(dockerfileDir, 'Dockerfile');

  if (!fs.existsSync(dockerfile)) {
    const msg = 'Dockerfile not found — cannot build locally';
    emit(JSON.stringify({ type: 'error', message: msg }));
    appendLog(msg);
    releaseLock();
    reject(new Error(msg));
    return;
  }

  const hash = getDockerfileHash();
  const noCache = opts.force ? '--no-cache ' : '';
  const cmd = hash
    ? `docker build ${noCache}-t ${LOCAL_IMAGE} --label olympus.dockerfile_hash=${hash} --progress=plain .`
    : `docker build ${noCache}-t ${LOCAL_IMAGE} --progress=plain .`;

  appendLog('');
  appendLog('=== Local build started (registry pull failed) ===');
  appendLog(`Dockerfile hash: ${hash || 'unknown'}`);
  appendLog('');

  emit(JSON.stringify({ type: 'status', message: 'Building agent base image locally...' }));

  const { exec } = require('child_process');
  const child = exec(cmd, {
    cwd: dockerfileDir,
    maxBuffer: 1024 * 1024 * 10,
  });

  pullChildProcess = child;

  child.stdout?.on('data', (chunk: string) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      appendLog(line);
      if (line.startsWith('#')) {
        emit(JSON.stringify({ type: 'step', message: line }));
      } else if (line.includes('Downloading') || line.includes('Extracting') || line.includes('Pulling')) {
        emit(JSON.stringify({ type: 'progress', message: line }));
      }
    }
  });

  child.stderr?.on('data', (chunk: string) => {
    const text = chunk.toString().trim();
    if (text) {
      appendLog(text);
      emit(JSON.stringify({ type: 'log', message: text }));
    }
  });

  child.on('close', (code: number) => {
    opts.signal?.removeEventListener('abort', () => {});
    if (code === 0) {
      appendLog('=== Build completed successfully ===');
      emit(JSON.stringify({ type: 'complete', message: 'Agent base image built successfully' }));
      releaseLock();
      resolve();
    } else {
      appendLog(`=== Build failed with exit code ${code} ===`);
      releaseLock();
      reject(new Error(`docker build exited with code ${code}`));
    }
  });

  child.on('error', (err: Error) => {
    opts.signal?.removeEventListener('abort', () => {});
    appendLog(`=== Build error: ${err.message} ===`);
    releaseLock();
    reject(err);
  });
}

/**
 * Main entry point: try pull first, fallback to local build.
 */
export async function buildAgentImage(opts: BuildOptions): Promise<void> {
  const { force = false, onEvent, signal } = opts;

  if (!dockerAvailable()) {
    const msg = 'Docker is not available — please install Docker and try again';
    onEvent?.(JSON.stringify({ type: 'error', message: msg }));
    throw new Error(msg);
  }

  if (!tryAcquireLock()) {
    throw new Error('An operation is already in progress');
  }

  const timestamp = Date.now();
  buildLogPath = `/tmp/olympus-build-${timestamp}.log`;

  const emit = (data: string) => {
    onEvent?.(data);
    try {
      const parsed = JSON.parse(data);
      if (parsed.message) appendLog(parsed.message);
    } catch { /* not JSON */ }
  };

  // If not forced and image already exists, check if update is needed
  if (!force && localImageExists()) {
    const remoteDigest = getRemoteDigest();
    if (!remoteDigest) {
      // Can't reach registry — use what we have
      emit(JSON.stringify({ type: 'complete', message: 'Image already exists (offline, cannot check for updates)' }));
      releaseLock();
      return;
    }

    // TODO: compare local vs remote digest to detect staleness
    // For now, if image exists and we can reach registry, skip
    emit(JSON.stringify({ type: 'complete', message: 'Image already exists' }));
    releaseLock();
    return;
  }

  // Force: remove local image first so we get a fresh pull
  if (force) {
    try {
      execSyncRaw(`docker rmi -f ${LOCAL_IMAGE} ${REGISTRY_IMAGE} 2>/dev/null || true`, { timeout: 5000 });
    } catch { /* ok */ }
  }

  appendLog(opts.force ? '=== Image refresh started ===' : '=== Image pull started ===');

  // Try pull from registry first
  const pulled = await pullFromRegistry(opts, emit);

  if (pulled) {
    releaseLock();
    return;
  }

  // Fallback: local build
  return new Promise<void>((resolve, reject) => {
    localBuild(opts, emit, resolve, reject);
  });
}
