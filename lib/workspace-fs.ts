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

/**
 * `stat` of one path: `<kind>|<size>|<mtime>`, kind being `regular file`, `directory`, … The mtime is
 * `%Y`: whole seconds since the epoch (the precision `stat -c` gives on every coreutils), so `mtimeMs`
 * is always a multiple of 1000.
 */
export function statArgv(p: string): string[] {
  return ['stat', '-c', '%F|%s|%Y', '--', p];
}

/** Runs find with its arguments as given and keeps what it printed when it exits non-zero. */
export const TREE_SCRIPT = 'find "$@" 2>/dev/null; exit 0';

/** The recursive listing under `root`: one `relPath|type|size|mtime` record per entry, NUL-terminated. */
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

/** Most entries one folder listing returns (`list=1`); a bigger folder answers the first ones and `truncated: true`. */
export const LIST_MAX_ENTRIES = 5000;
/** maxBuffer of a folder listing: well above what {@link LIST_MAX_ENTRIES} entries take, so a huge folder is cut by the parser, not by an exec error. */
export const LIST_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * The folder listing script: constant text, the folder is "$1" and the find arguments follow. A folder that is
 * gone or cannot be read fails like cat would (stderr names it, exit non-zero), so the route answers 404 or an
 * error and the page shows an error row instead of "Empty folder". Once the folder is readable, find runs as in
 * {@link TREE_SCRIPT}: an entry that vanishes mid-walk keeps the rest.
 */
export const LIST_SCRIPT = [
  '[ -d "$1" ] || { echo "$1: No such file or directory" >&2; exit 4; }',
  '[ -r "$1" ] && [ -x "$1" ] || { echo "$1: Permission denied" >&2; exit 5; }',
  'find "$@" 2>/dev/null; exit 0',
].join('\n');

/**
 * One folder, one level: `type|size|mtime|name` records, NUL-terminated (the name comes last, so it may hold
 * a `|` or a newline). Runs the same constant script as the tree (`find "$@"`, exit 0 when an entry vanishes);
 * the folder and every find argument go through "$@".
 */
export function listArgv(dir: string): string[] {
  return ['sh', '-c', LIST_SCRIPT, 'sh', dir, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y|%s|%T@|%f\\0'];
}

/**
 * Prints a file's bytes as base64 (coreutils), so the server gets the exact bytes: docker exec output is
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
/** Exit code of WRITE_SCRIPT when an expected mtime was given and the target's mtime is different. Nothing is written. */
export const WRITE_EXIT_CONFLICT = 23;

/**
 * The save script: constant text, the target is "$1", the content comes on stdin. It writes a
 * temporary file next to the target, gives it the target's mode and owner when the target exists
 * (cp -p, which POSIX and GNU both have), and renames it over the target, so a reader never sees a
 * half-written file. The content is copied as is: no newline is added.
 * An optional "$2" is the mtime (whole seconds) the caller saw when it opened the file: when the target
 * exists with a different `stat -c %Y`, or is gone, the script exits WRITE_EXIT_CONFLICT and writes nothing.
 * The check runs first, before `mkdir -p` (a refused save creates nothing), and again as the last step before
 * the rename, so the window left is the same second. After the rename it prints the target's new mtime
 * (whole seconds) as its only stdout line, so the caller needs no second `stat`.
 * `${target%/*}` (not dirname) keeps a directory name that ends in a newline intact.
 */
export const WRITE_SCRIPT = [
  'set -e',
  'target=$1',
  'expected=${2-}',
  'if [ -d "$target" ]; then exit ' + WRITE_EXIT_IS_DIR + '; fi',
  // A fifo or a device would block cp and cat: only a regular file (or a new one) is written.
  'if [ -e "$target" ] && [ ! -f "$target" ]; then exit ' + WRITE_EXIT_NOT_FILE + '; fi',
  // Without an expected mtime there is nothing to compare. A file the agent deleted is a conflict too, never a silent re-create.
  'check() {',
  '  [ -n "$expected" ] || return 0',
  '  [ -e "$target" ] || exit ' + WRITE_EXIT_CONFLICT,
  '  current=$(stat -c %Y -- "$target")',
  '  [ "$current" = "$expected" ] || exit ' + WRITE_EXIT_CONFLICT,
  '}',
  'check',
  'dir=${target%/*}',
  'mkdir -p -- "$dir"',
  'tmp=$(mktemp "$dir/.rev4a-save.XXXXXX")',
  // EXIT alone does not run on a signal in dash: a killed save would leave the temp file behind.
  "trap 'rm -f -- \"$tmp\"' EXIT",
  "trap 'rm -f -- \"$tmp\"; exit 1' HUP INT TERM",
  // A new file gets the usual 0644 (mktemp creates 0600); an existing one keeps its mode and owner.
  'if [ -e "$target" ]; then cp -p -- "$target" "$tmp"; else chmod 644 "$tmp"; fi',
  'cat > "$tmp"',
  'check',
  'mv -f -- "$tmp" "$target"',
  'trap - EXIT HUP INT TERM',
  // The only stdout line: the new mtime. Never fatal: the file is saved either way.
  'stat -c %Y -- "$target" || true',
].join('\n');

/**
 * The argv that saves stdin to `p`. Run with `dockerExecWithInput`. `expectedMtimeSeconds`, when given,
 * turns on the conflict check (see WRITE_SCRIPT); it travels as a positional argument, never in the script.
 */
export function writeArgv(p: string, expectedMtimeSeconds?: number): string[] {
  const argv = ['sh', '-c', WRITE_SCRIPT, 'sh', p];
  if (expectedMtimeSeconds !== undefined) argv.push(String(expectedMtimeSeconds));
  return argv;
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
  /** Set (true) only for an entry inside a read-only mount. */
  readOnly?: boolean;
}

export interface StatResult {
  kind: 'file' | 'directory' | 'other';
  size: number;
  /** Modification time in ms; a multiple of 1000 (the stat gives whole seconds). Absent for the old two-field output. */
  mtimeMs?: number;
}

/** Output of `statArgv`: `<kind>|<size>|<mtime seconds>` (the old `<kind>|<size>` is read too). */
export function parseStat(out: string): StatResult | null {
  const parts = out.replace(/\n+$/, '').split('|');
  if (parts.length < 2) return null;
  // The kind never holds a "|"; neither do the numbers. Read from the right.
  let mtimeMs: number | undefined;
  if (parts.length >= 3) {
    const sec = Number(parts.pop() as string);
    if (!Number.isFinite(sec)) return null;
    mtimeMs = Math.round(sec * 1000);
  }
  const size = Number(parts.pop() as string);
  const kind = parts.join('|');
  if (!Number.isFinite(size)) return null;
  const extra = mtimeMs === undefined ? {} : { mtimeMs };
  if (kind === 'directory') return { kind: 'directory', size, ...extra };
  if (kind === 'regular file' || kind === 'regular empty file') return { kind: 'file', size, ...extra };
  return { kind: 'other', size, ...extra };
}

/** Output of `treeArgv` under `root`. Hidden top-level entries are left out, like the old listing. */
export function parseTree(out: string, root: string, readOnlyPaths: string[] = []): WorkspaceEntry[] {
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
    const entryPath = posix.join(root, relPath);
    entries.push({
      name: posix.basename(relPath),
      path: entryPath,
      relPath,
      type: isDirectory ? 'directory' : 'file',
      size: isDirectory ? 0 : Number(rawSize || 0),
      mtimeMs: Math.round(Number(rawMtime || 0) * 1000),
      isDirectory,
      isFile: !isDirectory,
      ...(readOnlyPaths.length > 0 && isInReadOnlyMount(entryPath, readOnlyPaths) ? { readOnly: true } : {}),
    });
  }
  entries.sort(compareWorkspaceEntries);
  return entries;
}

/** Output of `dirListArgv`: the visible entries, folders first and then by name (like the old `ls` listing). */
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
  files.sort((a, b) =>
    compareWorkspaceEntries(
      { relPath: a.name, type: a.isDirectory ? 'directory' : 'file' },
      { relPath: b.name, type: b.isDirectory ? 'directory' : 'file' },
    ));
  return files;
}

export interface ParsedList {
  entries: WorkspaceEntry[];
  /** True when the folder holds more than {@link LIST_MAX_ENTRIES} shown entries: only the first ones are returned. */
  truncated: boolean;
}

/**
 * Output of {@link listArgv} for the folder `dir` (an absolute path inside the workspace root).
 * `relPath` is relative to the workspace root. Dot-entries are left out unless `hidden`, except the
 * root of a read-only mount (the `.rev4a` rules), which is always listed. Folders first, then by name;
 * cut at {@link LIST_MAX_ENTRIES}. `forceReadOnly` marks every entry (the folder itself is read-only).
 */
export function parseList(
  out: string,
  dir: string,
  opts: { hidden?: boolean; readOnlyPaths?: string[]; forceReadOnly?: boolean; limit?: number } = {},
): ParsedList {
  const readOnlyPaths = opts.readOnlyPaths ?? [];
  const limit = opts.limit ?? LIST_MAX_ENTRIES;
  const entries: WorkspaceEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    // type, size and mtime never hold a `|`; the name (last) may.
    const a = rec.indexOf('|');
    const b = a < 0 ? -1 : rec.indexOf('|', a + 1);
    const c = b < 0 ? -1 : rec.indexOf('|', b + 1);
    if (c < 0) continue;
    const name = rec.slice(c + 1);
    if (!name || name.includes('/')) continue;
    const entryPath = posix.join(dir, name);
    const readOnlyRoot = readOnlyPaths.includes(entryPath);
    if (name.startsWith('.') && !opts.hidden && !readOnlyRoot) continue;
    const isDirectory = rec.slice(0, a) === 'd';
    const size = Number(rec.slice(a + 1, b));
    const mtime = Number(rec.slice(b + 1, c));
    entries.push({
      name,
      path: entryPath,
      relPath: posix.relative(WORKSPACE_ROOT, entryPath),
      type: isDirectory ? 'directory' : 'file',
      size: isDirectory || !Number.isFinite(size) ? 0 : size,
      mtimeMs: Number.isFinite(mtime) ? Math.round(mtime * 1000) : 0,
      isDirectory,
      isFile: !isDirectory,
      ...(opts.forceReadOnly || (readOnlyPaths.length > 0 && isInReadOnlyMount(entryPath, readOnlyPaths)) ? { readOnly: true } : {}),
    });
  }
  entries.sort(compareWorkspaceEntries);
  const truncated = entries.length > limit;
  return { entries: truncated ? entries.slice(0, limit) : entries, truncated };
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

// ── Raw mode: the exact bytes of a file the browser can show with its own viewer ─────────────

/** Largest file the raw mode serves; a bigger one answers 413. */
export const MAX_RAW_BYTES = 50 * 1024 * 1024;

/** The only types the raw mode serves, by lowercase extension (no dot). Anything else is 415. */
export const RAW_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
};

/** The content type for a path's extension (case-insensitive), or null when raw mode does not serve it. */
export function rawContentType(p: string): string | null {
  const base = posix.basename(p);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(RAW_TYPES, ext) ? RAW_TYPES[ext] : null;
}

/** Headers of a raw response for a file of `size` bytes. */
export function rawHeaders(p: string, size: number): Record<string, string> {
  const type = rawContentType(p) ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Length': String(size),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeRfc5987(posix.basename(p))}`,
    'Cache-Control': 'no-store',
  };
  if (type === 'image/svg+xml') {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  }
  return headers;
}

/** encodeURIComponent plus the characters it leaves alone that RFC 5987 does not allow in a value. */
function encodeRfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Deadline of a raw read: 15 s plus 1 s per MiB, at most 90 s. */
export function rawTimeoutMs(size: number): number {
  const mib = Math.ceil(Math.max(0, size) / (1024 * 1024));
  return Math.min(90_000, 15_000 + mib * 1000);
}

/** maxBuffer for a raw read: base64 is 4/3 of the bytes, plus headroom for growth between stat and read. */
export const RAW_MAX_BUFFER = Math.ceil((MAX_RAW_BYTES * 4) / 3) + 1024 * 1024;

// ── Download: the exact bytes of any regular file ────────────────────────────────────────────

/** Headers of a download response: always an attachment of opaque bytes, never rendered by the browser. */
export function downloadHeaders(p: string, size: number): Record<string, string> {
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(size),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeRfc5987(posix.basename(p))}`,
    'Cache-Control': 'no-store',
  };
}

// ── Tail and range reads, file info ──────────────────────────────────────────────────────────

/** Default size of a tail read. */
export const DEFAULT_TAIL_BYTES = 256 * 1024;
/** Largest tail or range read. */
export const MAX_WINDOW_BYTES = MAX_READ_BYTES;
/** How much of a file the info mode looks at. */
export const INFO_BYTES = 4096;

/** A missing file fails like cat would, so mapExecError answers 404 (base64 alone would exit 0 on nothing). */
const REQUIRE_FILE = '[ -f "$2" ] || { echo "$2: No such file or directory" >&2; exit 4; }';

/**
 * The last bytes of a file. "$1" is the byte count, "$2" the file. Constant text. Prints the file size on
 * the first line, then the base64 of exactly the last min(size, count) bytes OF THAT SIZE: size and bytes
 * come from the same call, so a log the agent appends to meanwhile cannot shift the window (the bytes it
 * appends after the stat are not shown; the next read shows them).
 */
export const TAIL_SCRIPT = [
  REQUIRE_FILE,
  's=$(stat -c %s -- "$2")',
  'if [ "$s" -gt "$1" ]; then from=$((s - $1)); else from=0; fi',
  'printf "%s\\n" "$s"',
  'tail -c +$((from + 1)) -- "$2" | head -c $((s - from)) | base64 -w0',
].join('\n');
/** A byte range. "$1" is `+<offset + 1>` (tail -c from a position), "$2" the file, "$3" the length. Constant text. Size line first, as TAIL_SCRIPT. */
export const RANGE_SCRIPT = [
  REQUIRE_FILE,
  'printf "%s\\n" "$(stat -c %s -- "$2")"',
  'tail -c "$1" -- "$2" | head -c "$3" | base64 -w0',
].join('\n');

/** Splits the output of TAIL_SCRIPT / RANGE_SCRIPT into the file size at read time and the base64 bytes. */
export function splitSizedOutput(out: string): { size: number; base64: string } | null {
  const nl = out.indexOf('\n');
  if (nl < 0) return null;
  const size = Number(out.slice(0, nl));
  if (!Number.isSafeInteger(size) || size < 0) return null;
  return { size, base64: out.slice(nl + 1) };
}

/** The last `bytes` bytes of `p` (`bytes` a positive integer). */
export function tailArgv(p: string, bytes: number): string[] {
  return ['sh', '-c', TAIL_SCRIPT, 'sh', String(bytes), p];
}

/** `length` bytes of `p` from `offset` (both integers, `length` positive, `offset` not negative). */
export function rangeArgv(p: string, offset: number, length: number): string[] {
  return ['sh', '-c', RANGE_SCRIPT, 'sh', `+${offset + 1}`, p, String(length)];
}

/** A whole, non-negative integer written in decimal digits only, or null. */
export function parseWholeNumber(v: string | null): number | null {
  if (v === null || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

export interface TextWindow {
  content: string;
  /** Byte offset of the first returned byte (after dropping a partial leading character). */
  offset: number;
  /** Byte length of what is returned. */
  length: number;
}

/** How many bytes the UTF-8 sequence that starts with `lead` has (1 for ASCII and for a stray continuation byte). */
function utf8SequenceLength(lead: number): number {
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

/**
 * The text of a window read with {@link tailArgv} or {@link rangeArgv}, cut on character boundaries.
 * `offset` is where the window starts in the file, or null for a tail read (the window then ends at the
 * end of the file and starts at `fileSize - bytes read`). A partial character at the start (the window
 * began inside it) is dropped when the window does not start the file; a partial one at the end is dropped
 * when the window stops before the end of the file. A partial character at the very end of the file is not
 * dropped: it is not valid UTF-8, so the result is null, like for a whole file. Null also for any invalid
 * UTF-8 inside the window.
 */
export function decodeWindow(base64Out: string, offset: number | null, fileSize: number): TextWindow | null {
  const all = Buffer.from(base64Out, 'base64');
  const from = offset === null ? Math.max(0, fileSize - all.length) : offset;
  let start = 0;
  let end = all.length;
  if (from > 0) {
    while (start < end && start < 3 && (all[start] & 0xc0) === 0x80) start += 1;
  }
  if (from + all.length < fileSize) {
    for (let back = 1; back <= 3 && end - back >= start; back += 1) {
      const b = all[end - back];
      if ((b & 0xc0) === 0x80) continue;
      if (utf8SequenceLength(b) > back) end -= back;
      break;
    }
  }
  const slice = all.subarray(start, end);
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(slice);
    return { content, offset: from + start, length: end - start };
  } catch {
    return null;
  }
}

export interface FileInfo {
  kind: 'text' | 'binary' | 'empty';
  label?: string;
}

const hasPrefix = (b: Uint8Array, bytes: number[], at = 0) => bytes.every((v, i) => b[at + i] === v);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** A short description of a file from its first bytes (and its name for the ZIP-based Office formats), or undefined. */
export function detectFileLabel(b: Uint8Array, name = ''): string | undefined {
  if (hasPrefix(b, ascii('SQLite format 3\0'))) return 'SQLite database';
  if (hasPrefix(b, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(b, [0x50, 0x4b, 0x05, 0x06]) || hasPrefix(b, [0x50, 0x4b, 0x07, 0x08])) {
    return /\.(docx|xlsx|pptx)$/i.test(name) ? 'ZIP (Office document)' : 'ZIP archive';
  }
  if (hasPrefix(b, [0x1f, 0x8b])) return 'gzip archive';
  if (hasPrefix(b, ascii('ustar'), 257)) return 'tar archive';
  if (hasPrefix(b, ascii('%PDF-'))) return 'PDF document';
  if (hasPrefix(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'PNG image';
  if (hasPrefix(b, [0xff, 0xd8, 0xff])) return 'JPEG image';
  if (hasPrefix(b, ascii('GIF87a')) || hasPrefix(b, ascii('GIF89a'))) return 'GIF image';
  if (hasPrefix(b, ascii('RIFF')) && hasPrefix(b, ascii('WEBP'), 8)) return 'WebP image';
  if (hasPrefix(b, [0x7f, 0x45, 0x4c, 0x46])) return 'ELF executable';
  if (hasPrefix(b, [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])) return 'WebAssembly module';
  if (hasPrefix(b, ascii('ftyp'), 4)) return 'MP4 video';
  if (hasPrefix(b, ascii('ID3'))) return 'MP3 audio';
  return undefined;
}

/**
 * What the first {@link INFO_BYTES} of a file say about it. `base64Out` is the output of
 * `rangeArgv(p, 0, INFO_BYTES)`. A NUL, or bytes that are not UTF-8 (a character cut by the end of the
 * sample does not count), make it binary.
 */
export function describeFile(base64Out: string, name: string, size: number): FileInfo {
  if (size === 0) return { kind: 'empty' };
  const bytes = Buffer.from(base64Out, 'base64');
  const label = detectFileLabel(bytes, name);
  const win = decodeWindow(base64Out, 0, size);
  const kind = win === null || win.content.includes('\0') ? 'binary' : 'text';
  return label ? { kind, label } : { kind };
}
