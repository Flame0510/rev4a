/**
 * buildAgentImage.ts
 *
 * Shared logic for obtaining the openclaw-agent-base Docker image.
 * Used by /api/agents/download-image, /api/agents/image-status, and
 * the olympus serve CLI.
 *
 * Strategy (in order):
 *   1. docker pull from ghcr.io/Flame0510/olympus/openclaw-agent-base:latest (public, no auth)
 *   2. If pull fails (offline / no network) → fallback to local docker build
 *
 * Logs are written to /tmp/olympus-download-<timestamp>.log so they survive
 * page refreshes and modal closes.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync as execSyncRaw } from 'child_process';

const REGISTRY_IMAGE = 'ghcr.io/Flame0510/olympus/openclaw-agent-base:latest';
const LOCAL_IMAGE = 'openclaw-agent-base:latest';

let isDownloading = false;
let downloadLogPath: string | null = null;
let downloadChildProcess: ReturnType<(typeof import('child_process'))['exec']> | null = null;

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


/** Checks if a download is already running (in-process flag only). */
export function getIsDownloading(): boolean {
  return isDownloading;
}

/** Acquire the lock atomically. Returns false if already locked. */
function tryAcquireLock(): boolean {
  if (getIsDownloading()) return false;
  isDownloading = true;
  return true;
}

/** Release the lock and clear state. */
function releaseLock(): void {
  isDownloading = false;
  downloadLogPath = null;
  downloadChildProcess = null;
}


function appendLog(msg: string): void {
  if (!downloadLogPath) return;
  try {
    fs.appendFileSync(downloadLogPath, msg + '\n', 'utf-8');
  } catch { /* ignore */ }
}

/** Remove download log files older than 24 hours. */
function cleanupOldLogs(): void {
  try {
    const tmpDir = '/tmp';
    const files = fs.readdirSync(tmpDir);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of files) {
      if (!f.startsWith('olympus-download-') || !f.endsWith('.log')) continue;
      const fullPath = path.join(tmpDir, f);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch { /* ignore */ }
}

export interface DownloadOptions {
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
    const out = execSyncRaw(
      `docker manifest inspect ${REGISTRY_IMAGE} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    const manifest = JSON.parse(out);
    return manifest?.config?.digest || null;
  } catch {
    return null;
  }
}

/**
 * Pull the image from the public registry and tag it locally.
 */
async function pullFromRegistry(
  opts: DownloadOptions,
  emit: (data: string) => void,
): Promise<boolean> {
  if (!dockerAvailable()) {
    emit(JSON.stringify({ type: 'error', message: 'Docker is not available' }));
    appendLog('Docker not available — cannot download image');
    return false;
  }

  emit(JSON.stringify({ type: 'status', message: `Downloading ${REGISTRY_IMAGE}...` }));
  appendLog(`Downloading from registry: ${REGISTRY_IMAGE}`);

  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const child = exec(
      `docker pull ${REGISTRY_IMAGE}`,
      { maxBuffer: 1024 * 1024 * 5, timeout: 300_000 },
      (err: Error | null) => {
        if (err) {
          appendLog(`Download from registry failed: ${err.message}`);
          emit(JSON.stringify({ type: 'log', message: 'Registry download failed, trying local build...' }));
          resolve(false);
          return;
        }

        try {
          execSyncRaw(`docker tag ${REGISTRY_IMAGE} ${LOCAL_IMAGE}`, { timeout: 10_000 });
        } catch { /* ignore tag error */ }
        appendLog('Download completed successfully');
        emit(JSON.stringify({ type: 'complete', message: 'Image downloaded from registry' }));
        resolve(true);
      },
    );

    downloadChildProcess = child;

    child.stderr?.on('data', (chunk: Buffer) => {
      appendLog(chunk.toString());
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      appendLog(chunk.toString());
    });

    child.on('error', (err: Error) => {
      appendLog(`Pull process error: ${err.message}`);
      releaseLock();
      resolve(false);
    });
  });
}

/**
 * Local docker build fallback. Returns a Promise.
 */
function localBuild(
  opts: DownloadOptions,
  emit: (data: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
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
      ? `docker build ${noCache}-t ${LOCAL_IMAGE} --label "olympus.dockerfile_hash=${hash}" --progress=plain .`
      : `docker build ${noCache}-t ${LOCAL_IMAGE} --progress=plain .`;

    appendLog('');
    appendLog('=== Local build started (registry download failed) ===');
    appendLog(`Dockerfile hash: ${hash || 'unknown'}`);
    appendLog('');

    emit(JSON.stringify({ type: 'status', message: 'Building agent base image locally...' }));

    const { exec } = require('child_process');
    const child = exec(cmd, {
      cwd: dockerfileDir,
      maxBuffer: 1024 * 1024 * 10,
    });

    downloadChildProcess = child;

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
      appendLog(`=== Build error: ${err.message} ===`);
      releaseLock();
      reject(err);
    });
  });
}

/**
 * Main entry point: try pull first, fallback to local build.
 */
export async function downloadAgentImage(opts: DownloadOptions): Promise<void> {
  const { force = false, onEvent, signal } = opts;

  if (!dockerAvailable()) {
    const msg = 'Docker is not available — please install Docker and try again';
    onEvent?.(JSON.stringify({ type: 'error', message: msg }));
    throw new Error(msg);
  }

  if (!tryAcquireLock()) {
    throw new Error('A download is already in progress');
  }

  const timestamp = Date.now();
  downloadLogPath = `/tmp/olympus-download-${timestamp}.log`;

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
      emit(JSON.stringify({ type: 'complete', message: 'Image already downloaded (offline, cannot check for updates)' }));
      releaseLock();
      return;
    }

    emit(JSON.stringify({ type: 'complete', message: 'Image already downloaded' }));
    releaseLock();
    return;
  }

  // Force: remove local image first so we get a fresh pull
  if (force) {
    try {
      execSyncRaw(`docker rmi -f ${LOCAL_IMAGE} ${REGISTRY_IMAGE} 2>/dev/null || true`, { timeout: 5000 });
    } catch { /* ok */ }
  }

  appendLog(opts.force ? '=== Image refresh started ===' : '=== Image download started ===');

  // Try download from registry first
  const downloaded = await pullFromRegistry(opts, emit);

  if (downloaded) {
    cleanupOldLogs();
    releaseLock();
    return;
  }

  // Fallback: local build
  await localBuild(opts, emit);
  cleanupOldLogs();
}
