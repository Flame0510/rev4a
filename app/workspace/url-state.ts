/**
 * The Workspace page's URL state: `?agent=<container>&file=<path>&hidden=1`.
 *
 * Pure functions with no imports, so the page (a client bundle) and the node tests can both load this file.
 * The same confinement rule as `checkPath` in lib/workspace-fs.ts applies: a path must end inside the
 * workspace root once `.` and `..` are resolved. (Symlinks are not visible here; the API resolves them.)
 */

const ROOT = '/root/.openclaw/workspace';

export interface BrowseState {
  /** The container name of the agent, or null. */
  agent: string | null;
  /** The absolute path of the file inside the workspace root, or null. Only set together with a valid agent. */
  file: string | null;
  hidden: boolean;
}

/** The path read against the root with `.`, `..` and repeated slashes resolved, or null when it is empty, holds a NUL or ends outside the root. */
export function confineToRoot(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) return null;
  const parts = (input.startsWith('/') ? input : `${ROOT}/${input}`).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop(); else out.push(p);
  }
  const resolved = `/${out.join('/')}`;
  return resolved === ROOT || resolved.startsWith(`${ROOT}/`) ? resolved : null;
}

/**
 * The browse state a URL asks for. Anything invalid is dropped quietly: an agent that is not in
 * `knownContainers`, a file that is empty, holds a NUL, lies outside the workspace root after `..` or is the
 * root itself, and a file without a valid agent. `hidden` is on only for exactly `1`.
 */
export function parseBrowseState(
  params: { agent?: string | null; file?: string | null; hidden?: string | null },
  knownContainers: readonly string[],
): BrowseState {
  const agent = typeof params.agent === 'string' && knownContainers.includes(params.agent) ? params.agent : null;
  const confined = agent ? confineToRoot(params.file) : null;
  return { agent, file: confined && confined !== ROOT ? confined : null, hidden: params.hidden === '1' };
}

/** The `file` URL value for an absolute path: relative to the workspace root, which is shorter to read and share. */
export function browseFileParam(absPath: string): string {
  return absPath.startsWith(`${ROOT}/`) ? absPath.slice(ROOT.length + 1) : absPath;
}

/** The query string (`?a=b`, or empty) for a browse state. `file` is only written together with `agent`. */
export function buildBrowseQuery(state: { agent?: string | null; file?: string | null; hidden?: boolean }): string {
  const q = new URLSearchParams();
  if (state.agent) q.set('agent', state.agent);
  if (state.agent && state.file) q.set('file', browseFileParam(state.file));
  if (state.hidden) q.set('hidden', '1');
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The folders to open, outermost first, to show `file` (paths relative to the root; none for a file in the root). */
export function ancestorDirs(file: string): string[] {
  if (!file.startsWith(`${ROOT}/`)) return [];
  const parts = file.slice(ROOT.length + 1).split('/');
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join('/'));
  return dirs;
}

/**
 * The folders worth listing again: expanded AND visible, i.e. every ancestor is expanded too (paths relative
 * to the root). Outermost first, so a parent is listed before its children.
 */
export function visibleExpanded(expanded: Iterable<string>): string[] {
  const set = new Set(expanded);
  const out: string[] = [];
  for (const rel of set) {
    if (rel === '') continue;
    const parts = rel.split('/');
    let visible = true;
    for (let i = 1; i < parts.length; i++) {
      if (!set.has(parts.slice(0, i).join('/'))) { visible = false; break; }
    }
    if (visible) out.push(rel);
  }
  return out.sort((a, b) => a.split('/').length - b.split('/').length);
}

/** A file waiting to be opened from the URL, and the agent (workspace id) it belongs to. */
export interface PendingRestore { workspace: string; file: string }

/** The file to open for `workspaceId`: null when nothing is pending or the pending file belongs to another agent. */
export function restoreTarget(pending: PendingRestore | null, workspaceId: string): string | null {
  return pending && pending.workspace === workspaceId ? pending.file : null;
}
