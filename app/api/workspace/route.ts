import { execFile } from 'child_process';
import { promisify } from 'util';
import { NextResponse, type NextRequest } from 'next/server';
import { getAgentDisplayNames } from '@/lib/agent-names';
import { dockerExec, dockerExecWithInput } from '@/lib/docker-exec';
import { resolveDockerSocket } from '@/lib/docker-socket';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import {
  AGENT_PS_FORMAT,
  MAX_READ_BYTES,
  WORKSPACE_ROOT,
  WRITE_EXIT_IS_DIR,
  WRITE_EXIT_NOT_FILE,
  checkPath,
  dirListArgv,
  formatBytes,
  isInReadOnlyMount,
  isInside,
  mapExecError,
  parseAgentPs,
  parseDirList,
  parseStat,
  parseTree,
  parseWorkspaceId,
  readArgv,
  decodeReadOutput,
  readOnlyMountDestinations,
  realpathArgv,
  statArgv,
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  let wsId = url.searchParams.get('workspace');
  const filePath = url.searchParams.get('path');
  const wantsTree = url.searchParams.get('tree') === '1';

  try {
    // action=list → every agent container, running or stopped
    if (action === 'list') {
      try {
        return NextResponse.json({ workspaces: await listWorkspaces(), dockerAvailable: true });
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
      return treeResponse(ws, shown, parseTree(out, root));
    }

    if (!filePath) {
      const out = await inContainer(ws, dirListArgv(WORKSPACE_ROOT), 5000);
      return NextResponse.json({ workspace: ws.id, label: ws.label, path: WORKSPACE_PATH, type: 'container', files: parseDirList(out) });
    }

    const checked = checkPath(filePath);
    if (!checked.ok) return fail(checked.status, checked.error);
    const real = await resolveTarget(ws, filePath);
    const st = await statTarget(ws, real);

    if (st.kind === 'directory') {
      const out = await inContainer(ws, dirListArgv(real), 5000);
      return NextResponse.json({ workspace: ws.id, label: ws.label, path: checked.path, type: 'container', files: parseDirList(out) });
    }
    if (st.kind !== 'file') return fail(400, 'Not a regular file');
    if (st.size > MAX_READ_BYTES) {
      return fail(413, `File too large to open here (${formatBytes(st.size)}, limit 2 MB)`);
    }

    // maxBuffer has headroom over the limit: the file may grow between the stat and the read.
    // base64 is 4/3 of the bytes; headroom because the file may grow between the stat and the read.
    const content = decodeReadOutput(await inContainer(ws, readArgv(real), 10_000, MAX_READ_BYTES * 3));
    if (content === null) return fail(415, 'Not a UTF-8 text file: it cannot be opened or edited here');
    return NextResponse.json({ workspace: ws.id, label: ws.label, path: checked.path, type: 'container', content });
  } catch (e) {
    return failFrom(e);
  }
}

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

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    let body: { workspace?: unknown; path?: unknown; content?: unknown } | null;
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return fail(400, 'Invalid JSON body');
    }
    const { workspace, path: filePath, content } = body ?? {};
    if (typeof workspace !== 'string' || !workspace || typeof filePath !== 'string' || !filePath || typeof content !== 'string') {
      return fail(400, 'Missing workspace, path, or content');
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
      await dockerExecWithInput(ws.containerName, writeArgv(real), content, { timeoutMs: 15_000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes(`exited with code ${WRITE_EXIT_IS_DIR}`)) {
        return fail(400, 'That path is a directory');
      }
      if (msg.includes(`exited with code ${WRITE_EXIT_NOT_FILE}`)) {
        return fail(400, 'That path is not a regular file');
      }
      if (/Read-only file system/i.test(msg)) return fail(423, 'This location is read-only');
      const m = mapExecError(e, ws.label);
      return fail(m.status === 404 ? 500 : m.status, m.error);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failFrom(e);
  }
}
