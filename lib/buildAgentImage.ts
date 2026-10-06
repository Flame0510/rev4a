/**
 * buildAgentImage.ts
 *
 * Downloading the agent base image for one OpenClaw version. Used by
 * POST /api/agents/download-image (the Agents page banner) and
 * POST /api/setup/agent-image (the setup wizard, streamed).
 *
 * The image is pulled from the registry as `<registry>:<version>` — or, when the release
 * pins an image revision for the version, as `<registry>:<version>-<sha>` — and kept as
 * `openclaw-agent-base:<version>` (plus `<version>-rev.<sha>` for a pinned revision; see
 * lib/agent-images.ts). A version whose local image is a different revision than the pinned
 * one is downloaded again; agents keep the image they run. When the pull fails and
 * this repository's Dockerfile builds that same version, the image is built locally
 * instead — development without registry access. Any other version cannot be built
 * from here, so its download fails.
 *
 * One download at a time (in-process lock). Docker's output also goes to
 * /tmp/rev4a-download-<timestamp>.log (mode 0600, kept 24 h) for diagnosis — nothing in the
 * UI reads it; the banner gets its percent and status line from `getDownloadProgress()`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { imageRevisionStatus, isSupportedVersion, localImageRef, newestSupportedVersion, pinnedImageRevision, registryImageTag } from '@/lib/agent-versions';
import { listLocalAgentImages, localVersionExists, pullAgentImage, remoteSupportedVersions, runDocker } from '@/lib/agent-images';
import { dockerAvailable } from '@/lib/docker-socket';

const DOCKERFILE_DIR = path.join(process.cwd(), 'agent-templates', 'base-image');
const BUILD_TIMEOUT_MS = 60 * 60 * 1000;

/** The version being downloaded; `pending` while the default version is being resolved. */
let downloadingVersion: string | null = null;
let downloadLogPath: string | null = null;
/** Owns the running pull/build process; `cancelDownload()` aborts it. One at a time, like the download itself. */
let downloadController: AbortController | null = null;
/** `docker pull` layer ids seen, by state — the source of the real percent below. */
const pullLayers = new Map<string, 'pending' | 'done'>();
/** Set once a layer starts transferring: from then on the layer list is complete. */
let pullTransferStarted = false;
let downloadPercent: number | null = null;
/** The latest line of docker's output, shown under the percent (or alone when there is none). */
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

/** Real progress from `docker pull`'s own per-layer lines; `percent` is null until it can be computed (see `trackPullLayer`). */
export function getDownloadProgress(): { percent: number | null; message: string | null } {
  return { percent: downloadPercent, message: downloadMessage };
}

/**
 * Cancel the running download, if any: the docker process is killed, or never started
 * when the cancel arrives first (`runDocker` refuses an already-aborted signal). The
 * download rejects with a distinct 'canceled' error so the caller can tell it apart from
 * a real failure. Returns false when nothing is running.
 */
export function cancelDownload(): boolean {
  if (!downloadController) return false;
  downloadController.abort();
  return true;
}

/**
 * Whether the last finished download ended as cancelled. Derived from its recorded
 * outcome, not from the request: a cancel that arrives after the image is already tagged
 * changes nothing, and must not make a successful download read as cancelled.
 */
export function wasDownloadCanceled(): boolean {
  return lastDownloadResult?.result === 'canceled';
}

/**
 * Track `docker pull`'s per-layer lines to compute a real percent: the fraction of
 * layers finished. A layer is finished at `Pull complete` (downloaded *and* extracted) or
 * `Already exists` — not at `Download complete`, which still has the extraction ahead.
 *
 * Not byte-exact (layers differ in size and run in parallel), and deliberately withheld
 * until the first layer starts transferring: docker lists every layer up front, and a
 * percent computed before the list is complete jumps high on a cached first layer and
 * then falls (99 → 50 → 33 → 25 was reproduced). It also never goes down, and stays
 * below 100 — completion is reported by the download's outcome, not by a percent.
 */
function trackPullLayer(line: string): void {
  const m = /^([0-9a-f]{12}):\s+(.+)$/.exec(line.trim());
  if (!m) return;
  const [, id, state] = m;
  if (/^(Pulling fs layer|Waiting)/.test(state)) {
    if (!pullLayers.has(id)) pullLayers.set(id, 'pending');
  } else if (/^(Pull complete|Already exists)/.test(state)) {
    pullLayers.set(id, 'done');
  } else if (/^(Downloading|Verifying Checksum|Download complete|Extracting)/.test(state)) {
    if (!pullLayers.has(id)) pullLayers.set(id, 'pending');
    pullTransferStarted = true;
  } else {
    return;
  }
  if (!pullTransferStarted || pullLayers.size === 0) return;
  const done = [...pullLayers.values()].filter((v) => v === 'done').length;
  const percent = Math.min(99, Math.round((done / pullLayers.size) * 100));
  downloadPercent = Math.max(downloadPercent ?? 0, percent);
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
  pullLayers.clear();
  pullTransferStarted = false;
  downloadPercent = null;
  downloadMessage = null;
  downloadLogPath = `/tmp/rev4a-download-${Date.now()}.log`;
  try {
    // Owner-only, and 'wx' refuses a path that already exists (a planted file or link).
    fs.writeFileSync(downloadLogPath, '', { mode: 0o600, flag: 'wx' });
  } catch {
    downloadLogPath = null;
  }

  // Owns the child process for this run. A caller's own signal (the setup wizard's SSE
  // stream closing) aborts it too, same as cancelDownload() — both end up here, so
  // `signal.aborted` below is the one place that tells "stopped" from "failed".
  const controller = new AbortController();
  downloadController = controller;
  const onCallerAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const { signal } = controller;
  // Between awaits a cancel can arrive with no process to kill yet; stop at the next step.
  const stopIfCanceled = () => { if (signal.aborted) throw new Error('canceled'); };

  try {
    const version = opts.version ?? (await defaultDownloadVersion());
    stopIfCanceled();
    if (!isSupportedVersion(version)) throw new Error(`OpenClaw ${version} is not supported by this Rev4a`);
    downloadingVersion = version;

    // Present means the pinned revision when one is pinned: an older build is downloaded again.
    // A failed listing (the container read is part of it) must not fail the download: without
    // a pin, fall back to "the version tag exists", as before revisions; with one, try the pull.
    const pin = pinnedImageRevision(version);
    let revisionStatus: string;
    try {
      revisionStatus = imageRevisionStatus(version, await listLocalAgentImages());
    } catch {
      // Unknown revision: an existing image counts as outdated when pinned (never replaced by a
      // local build below), as current when not pinned.
      revisionStatus = (await localVersionExists(version)) ? (pin ? 'outdated' : 'current') : 'missing';
    }
    const present = revisionStatus === 'current';
    stopIfCanceled();
    if (present) {
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
      event('complete', `OpenClaw ${version} image downloaded`);
      lastDownloadResult = { version, result: 'succeeded', source: 'registry', message: `OpenClaw ${version} image downloaded`, at: Date.now() };
      return { version, source: 'registry' };
    } catch (e) {
      appendLog(`Registry download failed: ${(e as Error).message}`);
      if (signal.aborted) throw new Error('canceled');
      // A pinned build that cannot be downloaded must not be replaced by something else
      // while an image of this version exists: it stays as it is, tags untouched, and the
      // job fails. Only a missing version may fall back to a local build, below.
      if (pin && revisionStatus !== 'missing') {
        throw new Error(`The pinned build ${registryImageTag(version)} could not be downloaded: ${(e as Error).message}`);
      }
      if (dockerfileVersion() !== version) {
        throw new Error(`Could not download OpenClaw ${version}: ${(e as Error).message}`);
      }
    }

    event('log', pin ? `The pinned build ${registryImageTag(version)} could not be downloaded, building the image locally…` : 'Registry download failed, building the image locally…');
    downloadPercent = null;
    stopIfCanceled();
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
    const builtMessage = pin
      ? `OpenClaw ${version} image built locally because the pinned build ${registryImageTag(version)} could not be downloaded`
      : `OpenClaw ${version} image built locally`;
    event('complete', builtMessage);
    lastDownloadResult = { version, result: 'succeeded', source: 'build', message: builtMessage, at: Date.now() };
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
    opts.signal?.removeEventListener('abort', onCallerAbort);
    downloadingVersion = null;
    downloadLogPath = null;
    downloadController = null;
    pullLayers.clear();
    pullTransferStarted = false;
    downloadPercent = null;
    downloadMessage = null;
    cleanupOldLogs();
  }
}
