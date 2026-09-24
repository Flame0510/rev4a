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
/** Owns the running pull/build process; `cancelDownload()` aborts it. One at a time, like the download itself. */
let downloadController: AbortController | null = null;
/** Set right before aborting, so the caller can tell a cancel from a real failure. */
let downloadWasCanceled = false;
/** `docker pull` layer ids seen, by state — the source of the real percent below. */
const pullLayers = new Map<string, 'pending' | 'done'>();
let downloadPercent: number | null = null;
/** The latest status/progress/log line, shown verbatim while no percent is computable yet. */
let downloadMessage: string | null = null;

export interface DownloadOutcome {
  version: string;
  result: 'succeeded' | 'failed' | 'canceled';
  source?: 'present' | 'registry' | 'build';
  message: string;
  at: number;
}

/**
 * The last download's outcome, same idea as `finished` in lib/cold-backup.ts: a client
 * that was not mounted for the live `downloading: true → false` transition (navigated
 * away, reloaded, opened the page late) would otherwise see nothing at all once the
 * download is done — this is what it reads instead. Overwritten by the next download,
 * never cleared on its own; the client decides how long "recently" still means something.
 */
let lastDownloadResult: DownloadOutcome | null = null;

export function getLastDownloadResult(): DownloadOutcome | null {
  return lastDownloadResult;
}

/** Checks if a download is already running (in-process flag only). */
export function getIsDownloading(): boolean {
  return downloadingVersion !== null;
}

export function getDownloadingVersion(): string | null {
  return downloadingVersion === 'pending' ? null : downloadingVersion;
}

/** Real progress, from `docker pull`'s own layer-completion lines — null once nothing more is known than the status text. */
export function getDownloadProgress(): { percent: number | null; message: string | null } {
  return { percent: downloadPercent, message: downloadMessage };
}

/**
 * Cancel the running download, if any. `runDocker` kills the child process; the
 * download rejects with a distinct 'canceled' error so the caller can tell it apart
 * from a real failure. Returns false when nothing is running.
 */
export function cancelDownload(): boolean {
  if (!downloadController) return false;
  downloadWasCanceled = true;
  downloadController.abort();
  return true;
}

/** Whether the download that just stopped was canceled by the caller, not a failure. Reset on the next download. */
export function wasDownloadCanceled(): boolean {
  return downloadWasCanceled;
}

/**
 * Track `docker pull`'s per-layer lines to compute a real percent: each layer goes
 * `Pulling fs layer` → `Download complete`/`Already exists`, and the fraction of
 * layers done is a fair approximation of overall progress (layers pull in parallel,
 * so it is not byte-exact, but it only moves forward and reaches 100 exactly when
 * pulling does). Capped below 100 here; the caller sets 100 on real completion.
 */
function trackPullLayer(line: string): void {
  const m = /^([0-9a-f]{12}):\s+(Pulling fs layer|Waiting|Download complete|Already exists|Pull complete)/.exec(line);
  if (!m) return;
  const [, id, state] = m;
  if (state === 'Pulling fs layer' || state === 'Waiting') {
    if (!pullLayers.has(id)) pullLayers.set(id, 'pending');
  } else {
    pullLayers.set(id, 'done');
  }
  const total = pullLayers.size;
  if (total === 0) return;
  const done = [...pullLayers.values()].filter((v) => v === 'done').length;
  downloadPercent = Math.min(99, Math.round((done / total) * 100));
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
  downloadWasCanceled = false;
  pullLayers.clear();
  downloadPercent = null;
  downloadMessage = null;

  // Owns the child process for this run. A caller's own signal (the wizard's SSE
  // stream closing) aborts it too, same as cancelDownload() — both end up here, so
  // `signal.aborted` below is the one place that tells "stopped" from "failed".
  const controller = new AbortController();
  downloadController = controller;
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const { signal } = controller;

  try {
    const version = opts.version ?? (await defaultDownloadVersion());
    if (!isSupportedVersion(version)) throw new Error(`OpenClaw ${version} is not supported by this Rev4a`);
    downloadingVersion = version;

    if (await localVersionExists(version)) {
      event('complete', `OpenClaw ${version} image already downloaded`);
      lastDownloadResult = { version, result: 'succeeded', source: 'present', message: `OpenClaw ${version} image already downloaded`, at: Date.now() };
      return { version, source: 'present' };
    }

    event('status', `Downloading OpenClaw ${version} image…`);
    try {
      await pullAgentImage(version, {
        signal,
        onLine: (line) => {
          appendLog(line);
          downloadMessage = line;
          trackPullLayer(line);
          if (/Download|Extract|Pull/.test(line)) opts.onEvent?.(JSON.stringify({ type: 'progress', message: line }));
        },
      });
      downloadPercent = 100;
      event('complete', `OpenClaw ${version} image downloaded`);
      lastDownloadResult = { version, result: 'succeeded', source: 'registry', message: `OpenClaw ${version} image downloaded`, at: Date.now() };
      return { version, source: 'registry' };
    } catch (e) {
      appendLog(`Registry download failed: ${(e as Error).message}`);
      if (signal.aborted) throw new Error('canceled');
      if (dockerfileVersion() !== version) {
        throw new Error(`Could not download OpenClaw ${version}: ${(e as Error).message}`);
      }
    }

    event('log', 'Registry download failed, building the image locally…');
    downloadPercent = null;
    await runDocker(
      ['build', '--build-arg', `OPENCLAW_VERSION=${version}`, '-t', localImageRef(version), '--progress=plain', DOCKERFILE_DIR],
      {
        signal,
        timeoutMs: BUILD_TIMEOUT_MS,
        onLine: (line) => {
          appendLog(line);
          downloadMessage = line;
          if (line.startsWith('#')) opts.onEvent?.(JSON.stringify({ type: 'step', message: line }));
        },
      },
    );
    downloadPercent = 100;
    event('complete', `OpenClaw ${version} image built locally`);
    lastDownloadResult = { version, result: 'succeeded', source: 'build', message: `OpenClaw ${version} image built locally`, at: Date.now() };
    return { version, source: 'build' };
  } catch (e) {
    const version = downloadingVersion === 'pending' ? (opts.version ?? 'unknown') : downloadingVersion;
    if (signal.aborted) {
      lastDownloadResult = { version, result: 'canceled', message: `OpenClaw ${version} download canceled`, at: Date.now() };
      throw new Error('canceled');
    }
    lastDownloadResult = { version, result: 'failed', message: (e as Error).message, at: Date.now() };
    throw e;
  } finally {
    downloadingVersion = null;
    downloadLogPath = null;
    downloadController = null;
    pullLayers.clear();
    downloadPercent = null;
    downloadMessage = null;
    cleanupOldLogs();
  }
}
