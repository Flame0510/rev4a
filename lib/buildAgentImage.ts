/**
 * buildAgentImage.ts
 *
 * Shared logic for building the openclaw-agent-base Docker image.
 * Used by both /api/setup/agent-image (first-run setup) and
 * /api/agents/rebuild-image (post-setup rebuild).
 *
 * Logs are written to /tmp/olympus-build-<timestamp>.log so they survive
 * page refreshes and modal closes. The log path is exposed via getBuildLogPath().
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync as execSyncRaw } from 'child_process';

let isBuilding = false;
let buildLogPath: string | null = null;
let buildChildProcess: ReturnType<(typeof import('child_process'))['exec']> | null = null;

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

/** Checks if a docker build process is already running for the agent image. */
export function getIsBuilding(): boolean {
  if (isBuilding) return true;
  // Also check for orphaned docker build processes (e.g. server restart mid-build).
  try {
    const { execSync } = require('child_process');
    const out = execSync('ps aux | grep "[d]ocker.*build.*openclaw-agent-base"', {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Acquire the build lock atomically. Returns false if already locked. */
function tryAcquireLock(): boolean {
  if (getIsBuilding()) return false;
  isBuilding = true;
  return true;
}

/** Release the build lock and clear state. */
function releaseLock(): void {
  isBuilding = false;
  buildLogPath = null;
  buildChildProcess = null;
}

/**
 * Abort an in-progress build by killing the docker build process.
 * Returns true if a build was aborted, false if no build was running.
 */
export function abortBuild(): boolean {
  if (!isBuilding || !buildChildProcess) return false;
  try {
    appendLog('');
    appendLog('=== Build aborted by user ===');
    buildChildProcess.kill('SIGTERM');
    // Also kill any orphaned docker build
    try {
      const { execSync } = require('child_process');
      execSync("pkill -f 'docker.*build.*openclaw-agent-base' || true", { timeout: 2000 });
    } catch { /* ok */ }
    releaseLock();
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a line to the build log file.
 */
function appendLog(msg: string): void {
  if (!buildLogPath) return;
  try {
    fs.appendFileSync(buildLogPath, msg + '\n', 'utf-8');
  } catch { /* ignore write errors */ }
}

/**
 * Options for buildAgentImage.
 */
export interface BuildOptions {
  /** If true, always rebuild even if image already exists. */
  force?: boolean;
  /** Callback for SSE events. Omit to skip SSE (log-file-only mode). */
  onEvent?: (data: string) => void;
  /** AbortSignal to cancel the build on client disconnect */
  signal?: AbortSignal;
}

/**
 * Build the agent base image. All output is written to a log file;
 * SSE events are also emitted if onEvent is provided.
 */
export async function buildAgentImage(opts: BuildOptions): Promise<void> {
  const { force = false, onEvent, signal } = opts;

  if (!dockerAvailable()) {
    const msg = 'Docker is not available — please install Docker and try again';
    onEvent?.(JSON.stringify({ type: 'error', message: msg }));
    throw new Error(msg);
  }

  if (!tryAcquireLock()) {
    throw new Error('A build is already in progress');
  }

  const { exec } = await import('child_process');

  // Check if image already exists (skip unless forced)
  if (!force) {
    try {
      await new Promise<string>((resolve, reject) => {
        exec(
          'docker image inspect openclaw-agent-base:latest --format "{{.ID}}" 2>/dev/null',
          { timeout: 3000 },
          (err, stdout) => { if (err) reject(err); else resolve(stdout.trim()); },
        );
      });
      const msg = 'Image already exists';
      onEvent?.(JSON.stringify({ type: 'complete', message: msg }));
      releaseLock();
      return;
    } catch { /* doesn't exist — continue to build */ }
  }

  const hash = getDockerfileHash();
  const timestamp = Date.now();

  // Create log file
  buildLogPath = `/tmp/olympus-build-${timestamp}.log`;
  appendLog(force ? '=== Agent image rebuild started ===' : '=== Agent image build started ===');
  appendLog(`Dockerfile hash: ${hash || 'unknown'}`);
  appendLog('');

  const emit = (data: string) => {
    if (onEvent) onEvent(data);
    // Also extract message and write to log
    try {
      const parsed = JSON.parse(data);
      if (parsed.message) appendLog(parsed.message);
    } catch { /* not JSON */ }
  };

  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof exec> | null = null;

    const cleanup = () => {
      appendLog('');
      if (child && !child.killed) child.kill('SIGTERM');
      releaseLock();
    };

    if (signal) {
      signal.addEventListener('abort', cleanup, { once: true });
    }

    emit(JSON.stringify({ type: 'status', message: force ? 'Rebuilding agent base image...' : 'Building agent base image...' }));

    const dockerfileDir = path.join(process.cwd(), 'agent-templates', 'base-image');

    // Build with dockerfile_hash label and --no-cache for forced rebuilds
    const noCache = force ? '--no-cache ' : '';
    const cmd = hash
      ? `docker build ${noCache}-t openclaw-agent-base:latest --label olympus.dockerfile_hash=${hash} --progress=plain .`
      : `docker build ${noCache}-t openclaw-agent-base:latest --progress=plain .`;

    child = exec(cmd, {
      cwd: dockerfileDir,
      maxBuffer: 1024 * 1024 * 10,
    });

    // Stash reference for abort
    buildChildProcess = child;

    child.stdout?.on('data', (chunk: string) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        // Write all stdout to log file
        appendLog(line);

        if (line.startsWith('#')) {
          // Buildkit output — emit as step/progress
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

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', cleanup);
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

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', cleanup);
      appendLog(`=== Build error: ${err.message} ===`);
      releaseLock();
      reject(err);
    });
  });
}
