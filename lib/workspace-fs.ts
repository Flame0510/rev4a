/**
 * The Workspace page's file access inside agent containers: pure helpers only.
 *
 * Nothing here runs a command. The route (app/api/workspace/route.ts) runs the argv arrays
 * built here through lib/docker-exec.ts, so a container name, a path or a file's content is
 * never part of a shell string, on the host or in the container: the paths travel as argv
 * elements (or as a positional argument of a constant script) and the content travels on
 * stdin. No imports from the app, so node can load this file directly in the tests.
 */
import { posix } from 'node:path';

/** The agent's workspace inside its container, without a trailing slash. */
export const WORKSPACE_ROOT = '/root/.openclaw/workspace';

/** Largest file the page opens; a bigger one answers 413. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

/** Rule for a container name taken from a request. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** The container name in a workspace id (`container-<name>`), or null for anything else. */
export function parseWorkspaceId(id: unknown): string | null {
  if (typeof id !== 'string' || !id.startsWith('container-')) return null;
  const name = id.slice('container-'.length);
  return CONTAINER_NAME_RE.test(name) ? name : null;
}

export type PathCheck = { ok: true; path: string } | { ok: false; status: 400 | 403; error: string };

/**
 * Normalise a path taken from a request and keep it inside the workspace root.
 * A relative path is read against the root. Not a string, empty or holding a NUL: 400.
 * `..` or an absolute path that ends outside the root (a sibling such as `workspace-evil`
 * included): 403. Symlinks are NOT visible here: the route resolves them in the container.
 */
export function checkPath(input: unknown): PathCheck {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    return { ok: false, status: 400, error: 'Invalid path' };
  }
  const resolved = posix.resolve(WORKSPACE_ROOT, input);
  if (!isInside(resolved)) return { ok: false, status: 403, error: 'Path is outside the agent workspace' };
  return { ok: true, path: resolved };
}

/** True when an already-normalised absolute path is the root or below it. */
export function isInside(p: string): boolean {
  return p === WORKSPACE_ROOT || p.startsWith(`${WORKSPACE_ROOT}/`);
}

/** The normalised absolute path inside the workspace root, or null (bad or outside). */
export function confinePath(input: unknown): string | null {
  const r = checkPath(input);
  return r.ok ? r.path : null;
}

// ── Argv builders: each is the command that follows `docker exec <container>` ────────────────

/** Directories the tree skips (and does not descend into). */
export const TREE_PRUNED = ['node_modules', '.git', '.next', '.trash', 'cache'];

/** `realpath -m`: the path with symlinks resolved; the last parts may be missing. One line out. */
export function realpathArgv(p: string): string[] {
  return ['realpath', '-m', '--', p];
}

/** `stat` of one path: `<kind>|<size>`, kind being `regular file`, `directory`, … */
export function statArgv(p: string): string[] {
  return ['stat', '-c', '%F|%s', '--', p];
}

/** The recursive listing under `root`: one `relPath|type|size|mtime` record per entry, NUL-terminated. */
/** Runs find with its arguments as given and keeps what it printed when it exits non-zero. */
export const TREE_SCRIPT = 'find "$@" 2>/dev/null; exit 0';

export function treeArgv(root: string): string[] {
  const pruned: string[] = [];
  for (const name of TREE_PRUNED) pruned.push(pruned.length ? '-o' : '(', '-name', name);
  // find exits 1 when one entry vanishes mid-walk or the root does not exist yet: the entries it
  // printed are still right, so the tree keeps them (an empty tree for a missing root). The script
  // is constant; every argument goes through "$@". A timeout is still an error (the exec is killed).
  return ['sh', '-c', TREE_SCRIPT, 'sh', root, ...pruned, ')', '-prune', '-o', '-mindepth', '1', '-printf', '%P|%y|%s|%T@\\0'];
}

/** The entries directly inside `dir`: `type|name`, NUL-terminated. */
export function dirListArgv(dir: string): string[] {
  return ['find', dir, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y|%f\\0'];
}

/** Print a file's bytes. */
/**
 * Reads the file as base64 (coreutils), so the server gets the exact bytes: docker exec output is
 * decoded as UTF-8, which would silently turn the bytes of a non-UTF-8 file into U+FFFD.
 */
export function readArgv(p: string): string[] {
  return ['base64', '-w0', '--', p];
}

/**
 * The text of a file read with {@link readArgv}, or null when it is not valid UTF-8 (opening it
 * as text and saving would corrupt it). A leading BOM is kept as it is.
 */
export function decodeReadOutput(base64Out: string): string | null {
  const bytes = Buffer.from(base64Out.trim(), 'base64');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Exit code of WRITE_SCRIPT when the target is a directory. */
export const WRITE_EXIT_IS_DIR = 21;
/** Exit code of WRITE_SCRIPT when the target exists and is not a regular file (fifo, device, socket). */
export const WRITE_EXIT_NOT_FILE = 22;

/**
 * The save script: constant text, the target is "$1", the content comes on stdin. It writes a
 * temporary file next to the target, gives it the target's mode and owner when the target exists
 * (cp -p, which POSIX and GNU both have), and renames it over the target, so a reader never sees a
 * half-written file. The content is copied as is: no newline is added.
 * `${target%/*}` (not dirname) keeps a directory name that ends in a newline intact.
 */
export const WRITE_SCRIPT = [
  'set -e',
  'target=$1',
  'if [ -d "$target" ]; then exit ' + WRITE_EXIT_IS_DIR + '; fi',
  // A fifo or a device would block cp and cat: only a regular file (or a new one) is written.
  'if [ -e "$target" ] && [ ! -f "$target" ]; then exit ' + WRITE_EXIT_NOT_FILE + '; fi',
  'dir=${target%/*}',
  'mkdir -p -- "$dir"',
  'tmp=$(mktemp "$dir/.rev4a-save.XXXXXX")',
  // EXIT alone does not run on a signal in dash: a killed save would leave the temp file behind.
  "trap 'rm -f -- \"$tmp\"' EXIT",
  "trap 'rm -f -- \"$tmp\"; exit 1' HUP INT TERM",
  // A new file gets the usual 0644 (mktemp creates 0600); an existing one keeps its mode and owner.
  'if [ -e "$target" ]; then cp -p -- "$target" "$tmp"; else chmod 644 "$tmp"; fi',
  'cat > "$tmp"',
  'mv -f -- "$tmp" "$target"',
  'trap - EXIT HUP INT TERM',
].join('\n');

/** The argv that saves stdin to `p`. Run with `dockerExecWithInput`. */
export function writeArgv(p: string): string[] {
  return ['sh', '-c', WRITE_SCRIPT, 'sh', p];
}

// ── Parsers ──────────────────────────────────────────────────────────────────────────────────

export interface WorkspaceEntry {
  name: string;
  path: string;
  relPath: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
}

/** Output of `stat -c '%F|%s'`. */
export function parseStat(out: string): { kind: 'file' | 'directory' | 'other'; size: number } | null {
  const line = out.replace(/\n+$/, '');
  const i = line.lastIndexOf('|');
  if (i < 0) return null;
  const kind = line.slice(0, i);
  const size = Number(line.slice(i + 1));
  if (!Number.isFinite(size)) return null;
  if (kind === 'directory') return { kind: 'directory', size };
  if (kind === 'regular file' || kind === 'regular empty file') return { kind: 'file', size };
  return { kind: 'other', size };
}

/** Output of `treeArgv` under `root`. Hidden top-level entries are left out, like the old listing. */
export function parseTree(out: string, root: string): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    // The last three fields never hold a `|`; the name may.
    const parts = rec.split('|');
    if (parts.length < 4) continue;
    const rawMtime = parts.pop() as string;
    const rawSize = parts.pop() as string;
    const rawType = parts.pop() as string;
    const relPath = parts.join('|');
    if (!relPath || relPath.startsWith('.')) continue;
    const isDirectory = rawType === 'd';
    entries.push({
      name: posix.basename(relPath),
      path: posix.join(root, relPath),
      relPath,
      type: isDirectory ? 'directory' : 'file',
      size: isDirectory ? 0 : Number(rawSize || 0),
      mtimeMs: Math.round(Number(rawMtime || 0) * 1000),
      isDirectory,
      isFile: !isDirectory,
    });
  }
  entries.sort(compareWorkspaceEntries);
  return entries;
}

/** Output of `dirListArgv`: the visible entries, the same ones the old `ls` listing showed. */
export function parseDirList(out: string): { name: string; isDirectory: boolean; isFile: boolean }[] {
  const files: { name: string; isDirectory: boolean; isFile: boolean }[] = [];
  for (const rec of out.split('\0')) {
    const i = rec.indexOf('|');
    if (i < 0) continue;
    const name = rec.slice(i + 1);
    if (!name || name.startsWith('.') || TREE_PRUNED.includes(name)) continue;
    const isDirectory = rec.slice(0, i) === 'd';
    files.push({ name, isDirectory, isFile: !isDirectory });
  }
  return files;
}

/** Directories first at every level, then by name. */
export function compareWorkspaceEntries(a: { relPath: string; type: string }, b: { relPath: string; type: string }): number {
  const aSegs = a.relPath.split('/');
  const bSegs = b.relPath.split('/');
  const minLen = Math.min(aSegs.length, bSegs.length);
  for (let i = 0; i < minLen; i++) {
    if (aSegs[i] !== bSegs[i]) {
      const aIsDir = i < aSegs.length - 1 || a.type === 'directory';
      const bIsDir = i < bSegs.length - 1 || b.type === 'directory';
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return aSegs[i].localeCompare(bSegs[i]);
    }
  }
  return aSegs.length - bSegs.length;
}

export interface AgentContainer {
  name: string;
  agentId: string;
  running: boolean;
}

/** `docker ps -a` format for the agent containers: name, AGENT_ID label, state. */
export const AGENT_PS_FORMAT = '{{.Names}}|{{.Label "AGENT_ID"}}|{{.State}}';

export function parseAgentPs(out: string): AgentContainer[] {
  const rows: AgentContainer[] = [];
  for (const line of out.split('\n')) {
    const [name, agentId, state] = line.split('|');
    if (!name || !agentId || !CONTAINER_NAME_RE.test(name)) continue;
    rows.push({ name, agentId, running: state === 'running' });
  }
  return rows;
}

/** The mount destinations that are read-only, from `docker inspect --format '{{json .Mounts}}'`. */
export function readOnlyMountDestinations(mountsJson: string): string[] {
  let mounts: unknown;
  try {
    mounts = JSON.parse(mountsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(mounts)) return [];
  const out: string[] = [];
  for (const m of mounts) {
    const mount = m as { Destination?: unknown; RW?: unknown };
    if (mount && mount.RW === false && typeof mount.Destination === 'string' && mount.Destination) {
      out.push(posix.normalize(mount.Destination).replace(/(.)\/+$/, '$1'));
    }
  }
  return out;
}

/** True when `p` is a read-only mount's destination or inside one. */
export function isInReadOnlyMount(p: string, destinations: string[]): boolean {
  return destinations.some((d) => p === d || p.startsWith(d === '/' ? '/' : `${d}/`));
}

export interface MappedError { status: number; error: string }

/**
 * An error from a docker exec, as the response it deserves. `label` is the agent's display name.
 * dockerExec reports a failure as `docker exec <c>: <cause> — <stderr>`.
 */
export function mapExecError(e: unknown, label: string): MappedError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Docker is not available/i.test(msg)) return { status: 503, error: 'Docker is not available' };
  if (/No such file or directory/i.test(msg)) return { status: 404, error: 'File not found' };
  if (/is not running|No such container|is restarting|is paused/i.test(msg)) {
    return { status: 502, error: `Agent ${label} is not running` };
  }
  if (/timed out|maxBuffer/i.test(msg)) return { status: 502, error: `Agent ${label} did not answer in time` };
  return { status: 500, error: `Could not reach the agent's files: ${msg.replace(/^docker exec \S+: /, '').slice(0, 300)}` };
}

/** `1.5 MB`, `812 KB`: for the 413 message. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
