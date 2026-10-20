import { execFile } from 'child_process';
import { posix } from 'node:path';
import { promisify } from 'util';
import { NextResponse, type NextRequest } from 'next/server';
import { getAgentDisplayNames } from '@/lib/agent-names';
import { dockerExec, dockerExecWithInput } from '@/lib/docker-exec';
import { resolveDockerSocket } from '@/lib/docker-socket';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import {
  AGENT_PS_FORMAT,
  DEFAULT_TAIL_BYTES,
  INFO_BYTES,
  MAX_RAW_BYTES,
  MAX_WINDOW_BYTES,
  MAX_READ_BYTES,
  RAW_MAX_BUFFER,
  WORKSPACE_ROOT,
  WRITE_EXIT_CONFLICT,
  WRITE_EXIT_IS_DIR,
  WRITE_EXIT_NOT_FILE,
  checkPath,
  decodeWindow,
  describeFile,
  dirListArgv,
  downloadHeaders,
  formatBytes,
  isInReadOnlyMount,
  isInside,
  mapExecError,
  parseAgentPs,
  parseDirList,
  parseStat,
  parseTree,
  parseWholeNumber,
  parseWorkspaceId,
  rawContentType,
  rawHeaders,
  rangeArgv,
  splitSizedOutput,
  rawTimeoutMs,
  readArgv,
  decodeReadOutput,
  readOnlyMountDestinations,
  realpathArgv,
  statArgv,
  tailArgv,
  treeArgv,
  writeArgv,
} from '@/lib/workspace-fs';

const execFileAsync = promisify(execFile);

const WORKSPACE_PATH = `${WORKSPACE_ROOT}/`;
const HOST_DOCKER_TIMEOUT_MS = 5000;

// The host ("Local") workspace is gone: the page shows agent containers only.
if (process.env.REV4A_WORKSPACE_ROOT) {
  console.warn('[workspace] REV4A_WORKSPACE_ROOT is no longer used: the Workspace page shows agent containers only');
}

interface Workspace {
  id: string;
  label: string;
  type: 'container';
  path: string;
  containerName: string;
  running: boolean;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

function failFrom(e: unknown): NextResponse {
  if (e instanceof HttpError) return fail(e.status, e.message);
  return fail(500, e instanceof Error ? e.message : 'Workspace error');
}

/** Every agent container, running or stopped, once per request. Throws a 503 when Docker is down. */
async function listWorkspaces(): Promise<Workspace[]> {
  if (!resolveDockerSocket()) throw new HttpError(503, 'Docker is not available');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'docker',
      ['ps', '-a', '--filter', 'label=AGENT_ID', '--format', AGENT_PS_FORMAT],
      { timeout: HOST_DOCKER_TIMEOUT_MS, encoding: 'utf-8' },
    ));
  } catch {
    throw new HttpError(503, 'Docker is not available');
  }
  const rows = parseAgentPs(stdout);
  // Display names (AGENT_NAME) from the shared cached inspect, not an exec per container.
  const names = await getAgentDisplayNames(rows.map((r) => r.name));
  return rows.map((r) => ({
    id: `container-${r.name}`,
    label: names.get(r.name) || `${r.agentId} (${r.name})`,
    type: 'container' as const,
    path: WORKSPACE_PATH,
    containerName: r.name,
    running: r.running,
  }));
}

/** The workspace for an id: 400 when the id is malformed or names no agent container, 502 when it is stopped. */
async function requireRunningWorkspace(id: string): Promise<Workspace> {
  const name = parseWorkspaceId(id);
  if (!name) throw new HttpError(400, `Unknown workspace: ${id}`);
  const ws = (await listWorkspaces()).find((w) => w.containerName === name);
  if (!ws) throw new HttpError(400, `Unknown workspace: ${id}`);
  if (!ws.running) throw new HttpError(502, `Agent ${ws.label} is not running`);
  return ws;
}

/** Run a command in the agent's container; any failure becomes an HttpError with the right status. */
async function inContainer(ws: Workspace, argv: string[], timeoutMs: number, maxBuffer?: number): Promise<string> {
  try {
    return await dockerExec(ws.containerName, argv, { timeoutMs, ...(maxBuffer ? { maxBuffer } : {}) });
  } catch (e) {
    const m = mapExecError(e, ws.label);
    throw new HttpError(m.status, m.error);
  }
}

/** Check a requested path, then follow its symlinks inside the container and check the result again. */
async function resolveTarget(ws: Workspace, input: unknown): Promise<string> {
  const checked = checkPath(input);
  if (!checked.ok) throw new HttpError(checked.status, checked.error);
  const out = await inContainer(ws, realpathArgv(checked.path), 5000);
  const real = out.endsWith('\n') ? out.slice(0, -1) : out;
  if (!isInside(real)) throw new HttpError(403, 'Path is outside the agent workspace');
  return real;
}

async function statTarget(ws: Workspace, realPath: string) {
  const out = await inContainer(ws, statArgv(realPath), 5000);
  const st = parseStat(out);
  if (!st) throw new HttpError(500, 'Could not read the file information');
  return st;
}

function treeResponse(ws: Workspace, targetPath: string, entries: ReturnType<typeof parseTree>) {
  return NextResponse.json({
    workspace: ws.id,
    label: ws.label,
    path: targetPath,
    root: targetPath,
    type: 'container',
    entries,
    tree: entries,
    files: entries,
  });
}

/** Raw reads above this size count against RAW_LARGE_CONCURRENCY. */
const RAW_LARGE_BYTES = 8 * 1024 * 1024;
const RAW_LARGE_CONCURRENCY = 2;
let rawLargeInFlight = 0;

/** Destinations of the container's read-only mounts (the Rev4a rules at /.rev4a, for one). */
async function readOnlyMounts(containerName: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{json .Mounts}}', containerName],
      { timeout: HOST_DOCKER_TIMEOUT_MS, encoding: 'utf-8' },
    );
    return readOnlyMountDestinations(stdout);
  } catch {
    // Without the answer a save into the rules could not be refused: do not save blind.
    throw new HttpError(502, 'Could not check whether the location is writable');
  }
}


/** The read-only mounts that lie inside the workspace root, by container ([] when docker inspect fails). */
async function readOnlyPathsOf(containerName: string): Promise<string[]> {
  try {
    return (await readOnlyMounts(containerName)).filter(isInside);
  } catch {
    return [];
  }
}

/** {@link readOnlyPathsOf} remembered for a few seconds: the tree is polled every 5 s and the mounts do not change. */
const RO_CACHE_MS = 15_000;
const roCache = new Map<string, { at: number; paths: string[] }>();
async function cachedReadOnlyPaths(containerName: string): Promise<string[]> {
  const hit = roCache.get(containerName);
  if (hit && Date.now() - hit.at < RO_CACHE_MS) return hit.paths;
  const paths = await readOnlyPathsOf(containerName);
  roCache.set(containerName, { at: Date.now(), paths });
  return paths;
}

/**
 * The bytes of a regular file, read in one go and answered with `headers(path, length)`. A large read holds the
 * base64 text, the bytes and the response copy at once (about 3.3x the file): at most RAW_LARGE_CONCURRENCY of
 * them run together, so a few clicks cannot exhaust a small host.
 */
async function serveBytes(
  ws: Workspace,
  real: string,
  size: number,
  headers: (size: number) => Record<string, string>,
): Promise<NextResponse> {
  const large = size > RAW_LARGE_BYTES;
  if (large && rawLargeInFlight >= RAW_LARGE_CONCURRENCY) {
    return fail(503, 'Another large file is being opened: try again in a moment');
  }
  if (large) rawLargeInFlight += 1;
  try {
    // A timed-out or failed exec throws (never partial bytes); the length check catches a file that changed.
    // Buffer.from ignores the trailing newline of base64 output: no trim (it would copy the string).
    const bytes = Buffer.from(await inContainer(ws, readArgv(real), rawTimeoutMs(size), RAW_MAX_BUFFER), 'base64');
    if (bytes.length !== size) return fail(502, 'The file changed while it was read');
    // A view over the same memory (the Response still copies the body once).
    return new NextResponse(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), { status: 200, headers: headers(bytes.length) });
  } finally {
    if (large) rawLargeInFlight -= 1;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  let wsId = url.searchParams.get('workspace');
  const filePath = url.searchParams.get('path');
  const wantsTree = url.searchParams.get('tree') === '1';
  const wantsRaw = url.searchParams.get('raw') === '1';
  const wantsDownload = url.searchParams.get('download') === '1';
  const wantsInfo = url.searchParams.get('info') === '1';
  const tailParam = url.searchParams.get('tail');
  const offsetParam = url.searchParams.get('offset');
  const lengthParam = url.searchParams.get('length');

  try {
    // action=list → every agent container, running or stopped
    if (action === 'list') {
      try {
        const list = await listWorkspaces();
        // The read-only mounts inside each workspace (the Rev4a rules): a failed inspect leaves the list empty, not broken.
        const workspaces = await Promise.all(list.map(async (w) => ({ ...w, readOnlyPaths: await readOnlyPathsOf(w.containerName) })));
        return NextResponse.json({ workspaces, dockerAvailable: true });
      } catch (e) {
        if (e instanceof HttpError && e.status === 503) {
          return NextResponse.json({ workspaces: [], dockerAvailable: false });
        }
        throw e;
      }
    }

    // No workspace specified → default to the first running one
    if (!wsId) {
      const all = await listWorkspaces();
      const first = all.find((w) => w.running) ?? all[0];
      if (!first) return fail(400, 'No agent workspace available');
      wsId = first.id;
    }

    const ws = await requireRunningWorkspace(wsId);

    if (wantsTree) {
      const root = filePath ? await resolveTarget(ws, filePath) : WORKSPACE_ROOT;
      const shown = filePath ? root : WORKSPACE_PATH;
      const out = await inContainer(ws, treeArgv(root), 10_000, 10 * 1024 * 1024);
      return treeResponse(ws, shown, parseTree(out, root, await cachedReadOnlyPaths(ws.containerName)));
    }

    if (!filePath) {
      const out = await inContainer(ws, dirListArgv(WORKSPACE_ROOT), 5000);
      return NextResponse.json({ workspace: ws.id, label: ws.label, path: WORKSPACE_PATH, type: 'container', files: parseDirList(out) });
    }

    const checked = checkPath(filePath);
    if (!checked.ok) return fail(checked.status, checked.error);
    // Raw mode serves only the viewable types: refuse by extension before touching the container.
    if (wantsRaw && !wantsDownload && !wantsInfo && !rawContentType(checked.path)) return fail(415, 'No preview for this file type');
    // A tail or range read: validate the numbers before touching the container.
    let slice: { mode: 'tail'; bytes: number } | { mode: 'range'; offset: number; length: number } | null = null;
    if (tailParam !== null && (offsetParam !== null || lengthParam !== null)) return fail(400, 'Use tail, or offset with length, not both');
    if (tailParam !== null) {
      const bytes = tailParam === '' ? DEFAULT_TAIL_BYTES : parseWholeNumber(tailParam);
      if (bytes === null || bytes < 1 || bytes > MAX_WINDOW_BYTES) return fail(400, `tail must be a whole number from 1 to ${MAX_WINDOW_BYTES}`);
      slice = { mode: 'tail', bytes };
    } else if (offsetParam !== null || lengthParam !== null) {
      const offset = parseWholeNumber(offsetParam);
      const length = parseWholeNumber(lengthParam);
      if (offset === null || length === null) return fail(400, 'offset and length must both be whole numbers');
      if (length < 1 || length > MAX_WINDOW_BYTES) return fail(400, `length must be from 1 to ${MAX_WINDOW_BYTES}`);
      slice = { mode: 'range', offset, length };
    }
    const real = await resolveTarget(ws, filePath);
    const st = await statTarget(ws, real);

    if (wantsDownload) {
      if (st.kind === 'directory') return fail(400, 'That path is a directory');
      if (st.kind !== 'file') return fail(400, 'Not a regular file');
      if (st.size > MAX_RAW_BYTES) {
        return fail(413, `File too large to download here (${formatBytes(st.size)}, limit 50 MB)`);
      }
      return await serveBytes(ws, real, st.size, (n) => downloadHeaders(checked.path, n));
    }

    if (wantsInfo) {
      if (st.kind === 'directory') return fail(400, 'That path is a directory');
      if (st.kind !== 'file') return fail(400, 'Not a regular file');
      const sample = st.size === 0 ? '' : (splitSizedOutput(await inContainer(ws, rangeArgv(real, 0, INFO_BYTES), 10_000, 64 * 1024))?.base64 ?? '');
      const info = describeFile(sample, posix.basename(checked.path), st.size);
      return NextResponse.json({ path: checked.path, size: st.size, mtimeMs: st.mtimeMs ?? 0, ...info });
    }

    if (wantsRaw) {
      if (st.kind === 'directory') return fail(400, 'That path is a directory');
      if (st.kind !== 'file') return fail(400, 'Not a regular file');
      // A symlink named like an image must not hand out another file: the real path needs a served type too.
      if (!rawContentType(real)) return fail(415, 'No preview for this file type');
      if (st.size > MAX_RAW_BYTES) {
        return fail(413, `File too large to open here (${formatBytes(st.size)}, limit 50 MB)`);
      }
      return await serveBytes(ws, real, st.size, (n) => rawHeaders(checked.path, n));
    }

    if (st.kind === 'directory') {
      const out = await inContainer(ws, dirListArgv(real), 5000);
      return NextResponse.json({ workspace: ws.id, label: ws.label, path: checked.path, type: 'container', files: parseDirList(out) });
    }
    if (st.kind !== 'file') return fail(400, 'Not a regular file');
    if (slice) {
      // Any text file, whatever its size: only the slice is read. A timed-out exec throws; nothing partial is used.
      const out = await inContainer(
        ws,
        slice.mode === 'tail' ? tailArgv(real, slice.bytes) : rangeArgv(real, slice.offset, slice.length),
        15_000,
        MAX_WINDOW_BYTES * 3,
      );
      // The size from the same call as the bytes (a log may grow between the stat above and this read).
      const sized = splitSizedOutput(out);
      if (!sized) return fail(500, 'Could not read the file');
      const size = sized.size;
      const win = decodeWindow(sized.base64, slice.mode === 'tail' ? null : slice.offset, size);
      if (win === null) return fail(415, 'Not a UTF-8 text file: it cannot be opened or edited here');
      return NextResponse.json({
        workspace: ws.id,
        label: ws.label,
        path: checked.path,
        type: 'container',
        content: win.content,
        size,
        mtimeMs: st.mtimeMs ?? 0,
        offset: win.offset,
        length: win.length,
        truncated: win.offset > 0 || win.offset + win.length < size,
      });
    }
    if (st.size > MAX_READ_BYTES) {
      return fail(413, `File too large to open here (${formatBytes(st.size)}, limit 2 MB)`);
    }

    // maxBuffer has headroom over the limit: the file may grow between the stat and the read.
    // base64 is 4/3 of the bytes; headroom because the file may grow between the stat and the read.
    const content = decodeReadOutput(await inContainer(ws, readArgv(real), 10_000, MAX_READ_BYTES * 3));
    if (content === null) return fail(415, 'Not a UTF-8 text file: it cannot be opened or edited here');
    return NextResponse.json({ workspace: ws.id, label: ws.label, path: checked.path, type: 'container', content, size: st.size, mtimeMs: st.mtimeMs ?? 0 });
  } catch (e) {
    return failFrom(e);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    let body: { workspace?: unknown; path?: unknown; content?: unknown; expectedMtimeMs?: unknown } | null;
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return fail(400, 'Invalid JSON body');
    }
    const { workspace, path: filePath, content, expectedMtimeMs } = body ?? {};
    if (typeof workspace !== 'string' || !workspace || typeof filePath !== 'string' || !filePath || typeof content !== 'string') {
      return fail(400, 'Missing workspace, path, or content');
    }

    // Optional: the mtime the client saw when it opened the file. null counts as absent.
    let expectedSeconds: number | undefined;
    if (expectedMtimeMs !== undefined && expectedMtimeMs !== null) {
      // Negative is a real mtime (before 1970): only a non-number is refused.
      if (typeof expectedMtimeMs !== 'number' || !Number.isFinite(expectedMtimeMs)) {
        return fail(400, 'expectedMtimeMs must be a number');
      }
      expectedSeconds = Math.floor(expectedMtimeMs / 1000);
    }

    const checked = checkPath(filePath);
    if (!checked.ok) return fail(checked.status, checked.error);
    const ws = await requireRunningWorkspace(workspace);
    const real = await resolveTarget(ws, filePath);

    const readOnly = await readOnlyMounts(ws.containerName);
    if (isInReadOnlyMount(checked.path, readOnly) || isInReadOnlyMount(real, readOnly)) {
      return fail(423, 'This location is read-only: Rev4a manages it');
    }

    try {
      await dockerExecWithInput(ws.containerName, writeArgv(real, expectedSeconds), content, { timeoutMs: 15_000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes(`exited with code ${WRITE_EXIT_IS_DIR}`)) {
        return fail(400, 'That path is a directory');
      }
      if (msg.includes(`exited with code ${WRITE_EXIT_CONFLICT}`)) {
        // Nothing was written. The current mtime lets the client decide; without it the client still gets the 409.
        let mtimeMs: number | undefined;
        let deleted = false;
        try { mtimeMs = (await statTarget(ws, real)).mtimeMs; } catch (err) { deleted = err instanceof HttpError && err.status === 404; }
        return NextResponse.json({
          error: deleted ? 'The file was deleted on the agent since you opened it' : 'The file changed on the agent since you opened it',
          ...(deleted ? { deleted: true } : {}),
          ...(mtimeMs !== undefined ? { mtimeMs } : {}),
        }, { status: 409 });
      }
      if (msg.includes(`exited with code ${WRITE_EXIT_NOT_FILE}`)) {
        return fail(400, 'That path is not a regular file');
      }
      if (/Read-only file system/i.test(msg)) return fail(423, 'This location is read-only');
      const m = mapExecError(e, ws.label);
      return fail(m.status === 404 ? 500 : m.status, m.error);
    }
    // The new mtime, so the next save can check against it; the save itself succeeded either way.
    let mtimeMs: number | undefined;
    try { mtimeMs = (await statTarget(ws, real)).mtimeMs; } catch { /* ok without it */ }
    return NextResponse.json({ ok: true, ...(mtimeMs !== undefined ? { mtimeMs } : {}) });
  } catch (e) {
    return failFrom(e);
  }
}
