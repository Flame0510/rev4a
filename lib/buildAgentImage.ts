/**
 * buildAgentImage.ts
 *
 * Shared logic for building the openclaw-agent-base Docker image.
 * Used by both /api/setup/agent-image (first-run setup) and
 * /api/agents/rebuild-image (post-setup rebuild).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

let isBuilding = false;

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

/** Release the build lock. */
function releaseLock(): void {
  isBuilding = false;
}

/**
 * Options for buildAndStream.
 */
export interface BuildOptions {
  /** If true, always rebuild even if image already exists. */
  force?: boolean;
  /** Callback for SSE events { type: 'step'|'progress'|'status'|'complete'|'error', message: string } */
  onEvent: (data: string) => void;
  /** AbortSignal to cancel the build on client disconnect */
  signal?: AbortSignal;
}

/**
 * Build the agent base image and stream progress via callbacks.
 *
 * @returns Promise that resolves when the build completes or rejects on error.
 */
export async function buildAgentImage(opts: BuildOptions): Promise<void> {
  const { force = false, onEvent, signal } = opts;

  // Acquire lock before any async work — prevents race condition
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
      onEvent(JSON.stringify({ type: 'complete', message: 'Image already exists' }));
      releaseLock();
      return;
    } catch { /* doesn't exist — continue to build */ }
  }

  const hash = getDockerfileHash();

  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof exec> | null = null;

    const cleanup = () => {
      releaseLock();
      if (child && !child.killed) child.kill('SIGTERM');
    };

    if (signal) {
      signal.addEventListener('abort', cleanup, { once: true });
    }

    onEvent(JSON.stringify({ type: 'status', message: force ? 'Rebuilding agent base image...' : 'Building agent base image...' }));

    const dockerfileDir = path.join(process.cwd(), 'agent-templates', 'base-image');

    // Build with dockerfile_hash label (--label) and --no-cache for forced rebuilds
    const noCache = force ? '--no-cache ' : '';
    const cmd = hash
      ? `docker build ${noCache}-t openclaw-agent-base:latest --label olympus.dockerfile_hash=${hash} .`
      : `docker build ${noCache}-t openclaw-agent-base:latest .`;

    child = exec(cmd, {
      cwd: dockerfileDir,
      maxBuffer: 1024 * 1024 * 10,
    });

    child.stdout?.on('data', (chunk: string) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('Step')) {
          onEvent(JSON.stringify({ type: 'step', message: line }));
        } else if (line.includes('Downloading') || line.includes('Extracting') || line.includes('Pulling')) {
          onEvent(JSON.stringify({ type: 'progress', message: line }));
        }
      }
    });

    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.toString().trim();
      if (text) onEvent(JSON.stringify({ type: 'log', message: text }));
    });

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', cleanup);
      if (code === 0) {
        onEvent(JSON.stringify({ type: 'complete', message: 'Agent base image built successfully' }));
        releaseLock();
        resolve();
      } else {
        releaseLock();
        reject(new Error(`docker build exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', cleanup);
      releaseLock();
      reject(err);
    });
  });
}
