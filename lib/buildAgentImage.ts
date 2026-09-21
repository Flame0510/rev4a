/**
 * buildAgentImage.ts
 *
 * Downloading the agent base image for one OpenClaw version. Used by
 * POST /api/agents/download-image (the Agents page banner) and
 * POST /api/setup/agent-image (the setup wizard, streamed).
 *
 * The image is pulled from the registry as `<registry>:<version>` and kept as
 * `openclaw-agent-base:<version>` (see lib/agent-images.ts). When the pull fails and
 * this repository's Dockerfile builds that same version, the image is built locally
 * instead — development without registry access. Any other version cannot be built
 * from here, so its download fails.
 *
 * One download at a time (in-process lock). Output goes to
 * /tmp/rev4a-download-<timestamp>.log so it survives page refreshes and modal closes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isSupportedVersion, localImageRef, newestSupportedVersion } from '@/lib/agent-versions';
import { localVersionExists, pullAgentImage, remoteSupportedVersions, runDocker } from '@/lib/agent-images';
import { dockerAvailable } from '@/lib/docker-socket';

const DOCKERFILE_DIR = path.join(process.cwd(), 'agent-templates', 'base-image');
const BUILD_TIMEOUT_MS = 60 * 60 * 1000;

/** The version being downloaded; `pending` while the default version is being resolved. */
let downloadingVersion: string | null = null;
let downloadLogPath: string | null = null;

/** Checks if a download is already running (in-process flag only). */
export function getIsDownloading(): boolean {
  return downloadingVersion !== null;
}

export function getDownloadingVersion(): string | null {
  return downloadingVersion === 'pending' ? null : downloadingVersion;
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
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(tmpDir)) {
      if (!f.startsWith('rev4a-download-') || !f.endsWith('.log')) continue;
      const fullPath = path.join(tmpDir, f);
      if (fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
    }
  } catch { /* ignore */ }
}

/** The OpenClaw version this repository's Dockerfile builds (`ARG OPENCLAW_VERSION`). */
export function dockerfileVersion(): string | null {
  try {
    const content = fs.readFileSync(path.join(DOCKERFILE_DIR, 'Dockerfile'), 'utf-8');
    return /^ARG OPENCLAW_VERSION=(\S+)/m.exec(content)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** What a download without an explicit version fetches: the newest supported version the registry publishes, else the newest supported. */
export async function defaultDownloadVersion(): Promise<string> {
  return (await remoteSupportedVersions())?.[0] ?? newestSupportedVersion();
}

export interface DownloadOptions {
  version?: string;
  onEvent?: (data: string) => void;
  signal?: AbortSignal;
}

export interface DownloadResult {
  version: string;
  source: 'present' | 'registry' | 'build';
}

/**
 * Download one OpenClaw version of the agent image. Emits JSON events
 * (`status`, `progress`, `step`, `log`, `complete`) through `onEvent`; failures are
 * thrown, not emitted.
 */
export async function downloadAgentImage(opts: DownloadOptions = {}): Promise<DownloadResult> {
  const event = (type: string, message: string) => {
    opts.onEvent?.(JSON.stringify({ type, message }));
    appendLog(message);
  };

  if (!dockerAvailable()) throw new Error('Docker is not available — please install Docker and try again');
  if (downloadingVersion !== null) throw new Error('A download is already in progress');
  downloadingVersion = opts.version ?? 'pending';
  downloadLogPath = `/tmp/rev4a-download-${Date.now()}.log`;

  try {
    const version = opts.version ?? (await defaultDownloadVersion());
    if (!isSupportedVersion(version)) throw new Error(`OpenClaw ${version} is not supported by this Rev4a`);
    downloadingVersion = version;

    if (await localVersionExists(version)) {
      event('complete', `OpenClaw ${version} image already downloaded`);
      return { version, source: 'present' };
    }

    event('status', `Downloading OpenClaw ${version} image…`);
    try {
      await pullAgentImage(version, {
        signal: opts.signal,
        onLine: (line) => {
          appendLog(line);
          if (/Download|Extract|Pull/.test(line)) opts.onEvent?.(JSON.stringify({ type: 'progress', message: line }));
        },
      });
      event('complete', `OpenClaw ${version} image downloaded`);
      return { version, source: 'registry' };
    } catch (e) {
      appendLog(`Registry download failed: ${(e as Error).message}`);
      if (opts.signal?.aborted || dockerfileVersion() !== version) {
        throw new Error(`Could not download OpenClaw ${version}: ${(e as Error).message}`);
      }
    }

    event('log', 'Registry download failed, building the image locally…');
    await runDocker(
      ['build', '--build-arg', `OPENCLAW_VERSION=${version}`, '-t', localImageRef(version), '--progress=plain', DOCKERFILE_DIR],
      {
        signal: opts.signal,
        timeoutMs: BUILD_TIMEOUT_MS,
        onLine: (line) => {
          appendLog(line);
          if (line.startsWith('#')) opts.onEvent?.(JSON.stringify({ type: 'step', message: line }));
        },
      },
    );
    event('complete', `OpenClaw ${version} image built locally`);
    return { version, source: 'build' };
  } finally {
    downloadingVersion = null;
    downloadLogPath = null;
    cleanupOldLogs();
  }
}
