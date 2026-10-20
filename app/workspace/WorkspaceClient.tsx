'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ConfirmModal, Modal, Select } from '../components/ui';
import { Skeleton, TreeSkeleton, CodeSkeleton } from '../components/Skeleton';
import { apiFetch } from '@/lib/apiFetch';
import { renderMarkdownSafe } from '@/lib/markdown-safe';

/** Above this the Markdown preview is not rendered (marked takes seconds on huge files): the source is shown. */
const PREVIEW_MAX_CHARS = 256 * 1024;

// ─── Types ────────────────────────────────────────────────────────────────────
interface TreeEntry {
  path: string;
  relPath: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  /** True for an entry inside a read-only mount (the Rev4a rules). */
  readOnly?: boolean;
}

interface WorkspaceInfo {
  id: string;
  label: string;
  type: 'container';
  path: string;
  containerName: string;
  running: boolean;
  /** Read-only mounts inside the workspace root (absolute paths in the container). */
  readOnlyPaths?: string[];
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** What the editor pane shows for the selected file. Only `text` has an editor and a Save button. */
type FileView =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'text' }
  | { status: 'binary' }
  | { status: 'media'; kind: MediaKind; url: string }
  | { status: 'error'; message: string };

/** Files the browser shows with its own viewer or player, fetched as raw bytes. Never editable, never saveable. */
type MediaKind = 'image' | 'svg' | 'pdf' | 'audio' | 'video';

/** A log file opens on its last part, read-only; so does any text file the API refuses as too large (413). */
const TAIL_BYTES = 256 * 1024;
/** Most of a large or log file kept in memory by "Load earlier". */
const TAIL_MAX_BYTES = 2 * 1024 * 1024;

/** What the editor knows about a file opened on its last part (read-only). */
interface TailState {
  /** Size of the file when it was opened. */
  size: number;
  /** Byte offset of the first loaded byte; 0 when the whole start of the file is loaded. */
  offset: number;
  /** Bytes loaded so far. */
  loaded: number;
  loading: boolean;
  error: string | null;
}

/** What the API says about a file the editor cannot open as text. */
interface BinaryInfo { label?: string; size: number }

function isLogName(name: string): boolean { return /\.(log|out)$/i.test(name); }

const DEFAULT_ROOT = '/root/.openclaw/workspace/';
const POLL_MS = 5000;
const MAX_TREE_FAILURES = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const EXT_LANG: Record<string, string> = {
  '.md': 'markdown', '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.json': 'json', '.sh': 'bash',
  '.py': 'python', '.css': 'css', '.html': 'html',
  '.yaml': 'yaml', '.yml': 'yaml', '.txt': 'text', '.env': 'env',
};

/** Extensions the client never opens as text, never offers Save for (contract with the workspace API). */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.ico', '.sqlite', '.sqlite3', '.db',
  '.zip', '.gz', '.tar', '.tgz', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.wav', '.mov',
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.bin', '.exe', '.so',
]);

/** Same extensions as RAW_TYPES in lib/workspace-fs.ts (the raw mode answers 415 for anything else). */
const MEDIA_KINDS: Record<string, MediaKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.avif': 'image',
  '.bmp': 'image', '.ico': 'image', '.svg': 'svg', '.pdf': 'pdf',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.oga': 'audio', '.m4a': 'audio', '.flac': 'audio', '.aac': 'audio',
  '.mp4': 'video', '.m4v': 'video', '.webm': 'video', '.mov': 'video', '.ogv': 'video',
};

function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}
function isMarkdown(name: string) { return extOf(name) === '.md'; }
function mediaKindOf(name: string): MediaKind | null { return MEDIA_KINDS[extOf(name)] ?? null; }
function isBinaryExt(name: string): boolean { return BINARY_EXTS.has(extOf(name)); }
function hasNul(text: string): boolean { return text.indexOf('\u0000') !== -1; }

/** The path as shown to the user: relative to the workspace root, never the container-internal prefix. */
function displayPath(absPath: string, root: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  return absPath.startsWith(base) ? absPath.slice(base.length) : absPath;
}

/** The `error` text of a JSON error response, or a generic line when the body is not that. */
async function errorText(res: Response): Promise<string> {
  try {
    const data = await res.json() as { error?: unknown };
    if (typeof data.error === 'string' && data.error) return data.error;
  } catch { /* not JSON */ }
  return `Request failed (HTTP ${res.status})`;
}

function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}
function fmtDate(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ─── File type icon SVGs ──────────────────────────────────────────────────────
const COPPER = 'var(--violet)'; // #b8860b-ish

function FolderIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
      {expanded ? (
        <>
          <path d="M1.6 4a1.2 1.2 0 0 1 1.2-1.2H6l.8 1h4.4a1.2 1.2 0 0 1 1.2 1.2v5.8a1.2 1.2 0 0 1-1.2 1.2H2.8A1.2 1.2 0 0 1 1.6 10V4Z" fill={COPPER} stroke={COPPER} strokeWidth="0.3" strokeLinejoin="round" opacity="0.85"/>
          <line x1="1.6" y1="5.5" x2="12.4" y2="5.5" stroke="#0A0A0B" strokeWidth="0.8"/>
        </>
      ) : (
        <>
          <path d="M1.6 4a1.2 1.2 0 0 1 1.2-1.2H6l.8 1h4.4a1.2 1.2 0 0 1 1.2 1.2v5.8a1.2 1.2 0 0 1-1.2 1.2H2.8A1.2 1.2 0 0 1 1.6 10V4Z" fill={COPPER} stroke={COPPER} strokeWidth="0.3" strokeLinejoin="round" opacity="0.85"/>
        </>
      )}
    </svg>
  );
}

function FileIcon({ name, size }: { name: string; size?: number }) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  const s = size ?? 12;
  const color = '#888';
  const mono = (p: string) => <path d={p} stroke={color} strokeWidth="1.2" fill="none" strokeLinejoin="round"/>;
  const dim = { width: s, height: s, viewBox: `0 0 ${s} ${s}`, fill: 'none', stroke: color, strokeWidth: '1.2', style: { flexShrink: 0, opacity: 0.5 } as React.CSSProperties };
  const doc = <svg {...dim}><path d="M1 1h7L11 4v9H1z" strokeLinejoin="round"/><path d="M8 1v3h3" strokeLinejoin="round"/></svg>;
  switch (ext) {
    case '.md': return <svg {...dim}><path d="M1 1h7L11 4v9H1z" strokeLinejoin="round"/><path d="M8 1v3h3" strokeLinejoin="round"/><path d="M3 7h5M3 9h3" strokeLinecap="round"/></svg>;
    case '.ts':
    case '.tsx': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<text x="2.5" y="9" fontSize="5" fill="#3178c6" stroke="none" fontWeight="bold">TS</text></svg>;
    case '.js': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<text x="2.5" y="9" fontSize="5" fill="#f7df1e" stroke="none" fontWeight="bold">JS</text></svg>;
    case '.json': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<text x="2" y="9" fontSize="5" fill="#ecc" stroke="none">{'{ }'}</text></svg>;
    case '.sh': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<line x1="4" y1="5" x2="7" y2="10" stroke={color} strokeWidth="1"/><line x1="7" y1="5" x2="4" y2="10" stroke={color} strokeWidth="1"/></svg>;
    case '.py': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<rect x="3" y="6" width="5" height="4" rx="0.5" stroke={color} strokeWidth="0.8" fill="none"/></svg>;
    case '.css': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<path d="M9 9l2-3H4l1 3z" fill="#264de4" stroke="none"/></svg>;
    case '.html': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<path d="M3 7l1 3 1-3" stroke={color} strokeWidth="0.8" fill="none"/></svg>;
    case '.pdf': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<rect x="2.5" y="6" width="6" height="4.5" rx="0.3" fill="#ef4444" stroke="none" opacity="0.6"/></svg>;
    case '.png': case '.jpg': case '.jpeg': case '.gif': case '.webp': case '.svg':
      return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<circle cx="5" cy="7" r="2" fill={color} opacity="0.4" stroke="none"/><path d="M3 11l3-3 3 3" stroke={color} strokeWidth="0.8" fill="none"/></svg>;
    case '.yaml': case '.yml': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<line x1="3" y1="7" x2="8" y2="7" stroke={color} strokeWidth="0.8"/><line x1="3" y1="9" x2="6" y2="9" stroke={color} strokeWidth="0.8"/></svg>;
    case '.env': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<text x="3" y="9" fontSize="5" fill="#ffa" stroke="none">.env</text></svg>;
    case '.txt': return <svg {...dim}>{mono('M1 1h7L11 4v9H1z')}{mono('M8 1v3h3')}<rect x="3" y="7" width="5" height="0.8" fill={color} opacity="0.5" stroke="none"/><rect x="3" y="9" width="5" height="0.8" fill={color} opacity="0.5" stroke="none"/></svg>;
    default: return doc;
  }
}

// ─── Tree helpers ─────────────────────────────────────────────────────────────
interface TreeNode {
  name: string;
  relPath: string;
  absPath: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  readOnly?: boolean;
  children: TreeNode[];
}

function buildTree(entries: TreeEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const map = new Map<string, TreeNode>();

  for (const e of entries) {
    const node: TreeNode = { name: e.name, relPath: e.relPath, absPath: e.path, type: e.type, size: e.size, mtimeMs: e.mtimeMs, readOnly: e.readOnly, children: [] };
    map.set(e.relPath, node);
    const parentPath = e.relPath.includes('/') ? e.relPath.slice(0, e.relPath.lastIndexOf('/')) : null;
    if (parentPath && map.has(parentPath)) {
      map.get(parentPath)!.children.push(node);
    } else {
      root.push(node);
    }
  }
  return root;
}

// ─── Flatten tree into linear list for keyboard nav ───────────────────────────
interface FlatItem {
  node: TreeNode;
  depth: number;
  visible: boolean;
}

function flattenTree(tree: TreeNode[], expanded: Set<string>): FlatItem[] {
  const result: FlatItem[] = [];
  function walk(nodes: TreeNode[], depth: number) {
    for (const n of nodes) {
      result.push({ node: n, depth, visible: true });
      if (n.type === 'directory' && expanded.has(n.relPath)) {
        walk(n.children, depth + 1);
      }
    }
  }
  walk(tree, 0);
  return result;
}

// ─── TreeNodeRow ──────────────────────────────────────────────────────────────
function TreeNodeRow({
  node, depth, selected, expanded, onToggle, onSelect,
  id, focused,
}: {
  node: TreeNode; depth: number; selected: string | null;
  expanded: Set<string>; onToggle: (path: string, node?: TreeNode) => void; onSelect: (node: TreeNode) => void;
  id?: string; focused?: boolean;
}) {
  const isDir = node.type === 'directory';
  const isExp = expanded.has(node.relPath);
  const isSelected = selected === node.absPath;
  const indent = depth * 14;

  return (
    <div
      id={id}
      tabIndex={-1}
      onClick={() => isDir ? onToggle(node.relPath, node) : onSelect(node)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: `3px 8px 3px ${8 + indent}px`,
        cursor: 'pointer', userSelect: 'none', outline: 'none',
        background: isSelected ? '#1a1030' : 'transparent',
        color: isSelected ? 'var(--violet)' : isDir ? '#aaa' : '#ccc',
        fontSize: 11, fontFamily: 'var(--font-mono-stack)',
        borderLeft: isSelected ? '2px solid var(--violet)' : focused ? '2px solid #555' : '2px solid transparent',
        transition: 'background 0.1s',
      }}
      onMouseEnter={(e) => { if (!isSelected && !focused) (e.currentTarget as HTMLElement).style.background = '#111'; }}
      onMouseLeave={(e) => { if (!isSelected && !focused) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      {isDir ? (
        <svg width="10" height="10" viewBox="0 0 10 10" fill={COPPER} style={{ flexShrink: 0, transition: 'transform 0.15s', transform: isExp ? 'rotate(90deg)' : 'none', opacity: 0.7 }}>
          <path d="M3 2l4 3-4 3z"/>
        </svg>
      ) : (
        <span style={{ width: 10, flexShrink: 0 }} />
      )}
      {isDir ? (
        <FolderIcon expanded={isExp} />
      ) : (
        <FileIcon name={node.name} />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
      {!isDir && node.size > 0 && (
        <span style={{ marginLeft: 'auto', color: '#555', fontSize: 10, flexShrink: 0 }}>{fmtSize(node.size)}</span>
      )}
    </div>
  );
}

// ─── Centered message panel (empty, error and "not available" states) ─────────
function StatePanel({ title, message, action, tone = 'muted' }: { title: string; message?: string; action?: React.ReactNode; tone?: 'muted' | 'error' }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: tone === 'error' ? 'var(--red)' : '#aaa' }}>{title}</div>
      {message && <div style={{ fontSize: 11, color: '#666', maxWidth: 420, lineHeight: 1.6, overflowWrap: 'anywhere' }}>{message}</div>}
      {action}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function WorkspaceClient() {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treePaused, setTreePaused] = useState(false);
  const [treeReload, setTreeReload] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
  const [fileView, setFileView] = useState<FileView>({ status: 'idle' });
  /** The text as last loaded or saved; the editor buffer is `editContent`. */
  const [fileContent, setFileContent] = useState('');
  const [editContent, setEditContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  /** Set while the open file is shown on its last part only (a log, or a file over 2 MB): read-only. */
  const [tail, setTail] = useState<TailState | null>(null);
  const [binaryInfo, setBinaryInfo] = useState<BinaryInfo | null>(null);
  /** The agent changed the file after it was opened: the user chooses between reloading and overwriting. */
  /** A 409 on save: the agent changed the file, or deleted it, after it was opened. */
  const [conflict, setConflict] = useState<false | 'changed' | 'deleted'>(false);
  /** The file's mtime (ms) when it was last read or saved; sent with a save so a newer version is never overwritten blind. */
  const fileMtimeRef = useRef<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isDragging, setIsDragging] = useState(false);
  const [mobileView, setMobileView] = useState<'tree' | 'editor'>('tree');
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const flatItemsRef = useRef<FlatItem[]>([]);

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [dockerAvailable, setDockerAvailable] = useState(true);
  const [wsLoading, setWsLoading] = useState(true);
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsReload, setWsReload] = useState(0);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('');
  /** An in-app switch waiting for the user to confirm discarding unsaved edits. */
  const [pendingSwitch, setPendingSwitch] = useState<{ run: () => void } | null>(null);

  // Races (AGENTS.md 2.2b.10): one controller + one request id per file load; only the latest may set state.
  const fileAbortRef = useRef<AbortController | null>(null);
  /** The workspace the open file was loaded from: a save always goes back there, never to a newer selection. */
  const fileWorkspaceRef = useRef<string | null>(null);
  /**
   * True when the open file uses CRLF line endings throughout. A textarea gives back LF only, so the
   * text is edited with LF and turned back into CRLF on save; otherwise one keystroke would rewrite
   * every line ending of the file. (A file with mixed endings is edited as it comes.)
   */
  const crlfRef = useRef(false);
  const fileReqRef = useRef(0);
  /** The Blob URL of the open media file: revoked on every switch and on unmount. */
  const mediaUrlRef = useRef<string | null>(null);
  const releaseMedia = useCallback(() => {
    if (mediaUrlRef.current) { URL.revokeObjectURL(mediaUrlRef.current); mediaUrlRef.current = null; }
  }, []);
  useEffect(() => releaseMedia, [releaseMedia]);
  /** Image viewer: fitted to the pane or at 1:1, and the natural size once the image has loaded. */
  const [mediaFit, setMediaFit] = useState(true);
  const [mediaDims, setMediaDims] = useState<{ w: number; h: number } | null>(null);
  const saveBusyRef = useRef(false);
  const selectedPathRef = useRef<string | null>(null);
  const selectedWorkspaceRef = useRef('');
  selectedPathRef.current = selectedPath;
  selectedWorkspaceRef.current = selectedWorkspace;

  const current = workspaces.find((w) => w.id === selectedWorkspace) ?? null;
  const root = current?.path ?? DEFAULT_ROOT;
  const stopped = current != null && !current.running;
  const canBrowse = dockerAvailable && current != null && current.running;

  // Load the workspace list on mount, and again on "Check again".
  useEffect(() => {
    const controller = new AbortController();
    setWsLoading(true);
    void (async () => {
      try {
        const res = await apiFetch('/api/workspace?action=list', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const message = await errorText(res);
          if (controller.signal.aborted) return;
          setWorkspaces([]); setWsError(message);
          return;
        }
        const data = await res.json() as { workspaces?: WorkspaceInfo[]; dockerAvailable?: boolean };
        if (controller.signal.aborted) return;
        const list = Array.isArray(data.workspaces) ? data.workspaces : [];
        setWorkspaces(list);
        setDockerAvailable(data.dockerAvailable !== false);
        setWsError(null);
        setSelectedWorkspace((prev) => (
          list.some((w) => w.id === prev) ? prev : (list.find((w) => w.running) ?? list[0])?.id ?? ''
        ));
      } catch (e) {
        if (isAbort(e) || controller.signal.aborted) return;
        setWorkspaces([]); setWsError('Could not load the agent list.');
      } finally {
        if (!controller.signal.aborted) setWsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [wsReload]);

  // Load the tree, then poll it. No overlapping polls, and polling stops after repeated failures.
  useEffect(() => {
    if (!selectedWorkspace || !canBrowse) { setTreeLoading(false); return; }
    let active = true;
    let stop = false;
    let inFlight = false;
    let failures = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const load = async (showLoader: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (showLoader) setTreeLoading(true);
      const fail = (message: string, status?: number) => {
        failures += 1;
        setTreeError(message);
        // A stopped agent or a missing Docker will not fix itself in 5 s: stop at once.
        if (failures >= MAX_TREE_FAILURES || status === 502 || status === 503 || status === 400) {
          stop = true;
          setTreePaused(true);
        }
      };
      try {
        const res = await apiFetch(`/api/workspace?workspace=${encodeURIComponent(selectedWorkspace)}&tree=1`, { signal: controller.signal });
        if (!active) return;
        if (!res.ok) {
          const message = await errorText(res);
          if (active) fail(message, res.status);
          return;
        }
        const data = await res.json() as { entries?: TreeEntry[] };
        if (!active) return;
        failures = 0;
        setTreeError(null);
        setTreePaused(false);
        setTree(buildTree(Array.isArray(data.entries) ? data.entries : []));
      } catch (e) {
        if (!active || isAbort(e)) return;
        fail('Could not load the file list.');
      } finally {
        inFlight = false;
        if (showLoader && active) setTreeLoading(false);
      }
    };

    const scheduleNext = () => {
      clearTimeout(pollTimer);
      if (document.hidden || stop || !active) return; // don't poll when tab is hidden or after repeated failures
      pollTimer = setTimeout(async () => {
        await load(false);
        if (active) scheduleNext();
      }, POLL_MS);
    };

    const onVisibility = () => { if (!document.hidden) scheduleNext(); };
    document.addEventListener('visibilitychange', onVisibility);

    setTreeError(null);
    setTreePaused(false);
    void load(true).then(() => { if (active) scheduleNext(); });

    return () => {
      active = false;
      controller.abort();
      clearTimeout(pollTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [selectedWorkspace, canBrowse, treeReload]);

  // Load file: the latest request wins; an older response (or an aborted one) never touches state.
  const loadFile = useCallback(async (node: TreeNode) => {
    if (node.type !== 'file') return;
    fileAbortRef.current?.abort();
    const controller = new AbortController();
    fileAbortRef.current = controller;
    const reqId = ++fileReqRef.current;
    const workspaceId = selectedWorkspaceRef.current;
    const stale = () => reqId !== fileReqRef.current || controller.signal.aborted;
    fileWorkspaceRef.current = workspaceId;
    crlfRef.current = false;
    fileMtimeRef.current = null;
    setTail(null);
    setBinaryInfo(null);
    setConflict(false);
    releaseMedia();
    setMediaFit(true);
    setMediaDims(null);

    setSelectedPath(node.absPath);
    setSelectedNode(node);
    setSaveState('idle');
    setSaveError(null);
    setFileContent('');
    setEditContent('');
    setMobileView('editor');
    const mediaKind = mediaKindOf(node.name);
    const enc = `workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(node.absPath)}`;
    // The binary panel: shown at once, then completed with what the API says about the file (type label, size).
    const showBinary = () => {
      setFileView({ status: 'binary' });
      void (async () => {
        try {
          const res = await apiFetch(`/api/workspace?${enc}&info=1`, { signal: controller.signal });
          if (stale() || !res.ok) return;
          const info = await res.json() as { size?: unknown; label?: unknown };
          if (stale() || typeof info.size !== 'number') return;
          setBinaryInfo({ size: info.size, label: typeof info.label === 'string' ? info.label : undefined });
        } catch { /* the panel stays as it is */ }
      })();
    };
    if (!mediaKind && isBinaryExt(node.name)) { showBinary(); return; }
    setFileView({ status: 'loading' });
    // The last part of the file, read-only: for logs, and for text the API refuses as too large.
    const openTail = async () => {
      const res = await apiFetch(`/api/workspace?${enc}&tail=${TAIL_BYTES}`, { signal: controller.signal });
      if (stale()) return;
      if (!res.ok) {
        if (res.status === 415) { showBinary(); return; }
        const message = await errorText(res);
        if (!stale()) setFileView({ status: 'error', message });
        return;
      }
      const data = await res.json() as { content?: unknown; size?: unknown; mtimeMs?: unknown; offset?: unknown; length?: unknown };
      if (stale()) return;
      if (typeof data.content !== 'string' || typeof data.size !== 'number' || typeof data.offset !== 'number') {
        setFileView({ status: 'error', message: 'This path is not a file.' });
        return;
      }
      if (hasNul(data.content)) { showBinary(); return; }
      fileMtimeRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
      setFileContent(data.content);
      setEditContent(data.content);
      setPreviewMode(false);
      setTail({ size: data.size, offset: data.offset, loaded: typeof data.length === 'number' ? data.length : data.content.length, loading: false, error: null });
      setFileView({ status: 'text' });
    };
    try {
      if (mediaKind) {
        const rawUrl = `/api/workspace?workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(node.absPath)}&raw=1`;
        const res = await apiFetch(rawUrl, { signal: controller.signal });
        if (stale()) return;
        if (!res.ok) {
          const message = await errorText(res);
          if (!stale()) setFileView({ status: 'error', message });
          return;
        }
        // An SVG is shown from the API URL itself, never from a Blob URL: a Blob URL is same-origin with
        // the dashboard and does not carry the server's CSP sandbox, so "Open image in new tab" would run a
        // script inside the SVG with the dashboard's session. The API answer keeps the sandbox on a top-level open.
        if (mediaKind === 'svg') {
          void res.body?.cancel();
          setFileView({ status: 'media', kind: mediaKind, url: rawUrl });
          return;
        }
        const blob = await res.blob();
        if (stale()) return;
        const url = URL.createObjectURL(blob);
        mediaUrlRef.current = url;
        setFileView({ status: 'media', kind: mediaKind, url });
        return;
      }
      // A log opens on its last part only when it is larger than that part: a small log is an ordinary file.
      if (!mediaKind && isLogName(node.name) && node.size > TAIL_BYTES) { await openTail(); return; }
      const res = await apiFetch(`/api/workspace?${enc}`, { signal: controller.signal });
      if (stale()) return;
      if (!res.ok) {
        // 413: too large to edit; its last part opens read-only.
        if (res.status === 413) { void res.body?.cancel(); await openTail(); return; }
        // 415: the server read the bytes and they are not UTF-8 text: a binary file, not a failure.
        if (res.status === 415) { if (!stale()) showBinary(); return; }
        const message = await errorText(res);
        if (!stale()) setFileView({ status: 'error', message });
        return;
      }
      const data = await res.json() as { content?: unknown; mtimeMs?: unknown };
      if (stale()) return;
      if (typeof data.content !== 'string') { setFileView({ status: 'error', message: 'This path is not a file.' }); return; }
      if (hasNul(data.content)) { showBinary(); return; }
      fileMtimeRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
      const crlf = /\r\n/.test(data.content) && !/(^|[^\r])\n/.test(data.content);
      crlfRef.current = crlf;
      const text = crlf ? data.content.replace(/\r\n/g, '\n') : data.content;
      setFileContent(text);
      setEditContent(text);
      setPreviewMode(isMarkdown(node.name) && text.length <= PREVIEW_MAX_CHARS);
      setFileView({ status: 'text' });
    } catch (e) {
      if (isAbort(e) || stale()) return;
      setFileView({ status: 'error', message: 'Could not load the file.' });
    }
  }, [releaseMedia]);

  const dirty = fileView.status === 'text' && editContent !== fileContent;
  // A file inside a read-only mount (the Rev4a rules) is shown, never saved: the API would answer 423.
  const readOnlyRoots = current?.readOnlyPaths ?? [];
  const rev4aReadOnly = selectedPath != null && (selectedNode?.readOnly === true || readOnlyRoots.some((d) => selectedPath === d || selectedPath.startsWith(`${d}/`)));
  const canSave = dirty && saveState !== 'saving' && !rev4aReadOnly && tail === null;

  const saveFile = useCallback(async (overwrite = false) => {
    if (!selectedPath || fileView.status !== 'text' || editContent === fileContent || saveBusyRef.current || tail !== null) return;
    saveBusyRef.current = true;
    const path = selectedPath;
    const workspaceId = fileWorkspaceRef.current;
    // The selection moved to another agent (its list was reloaded): never write this text there.
    if (!workspaceId || workspaceId !== selectedWorkspace) { saveBusyRef.current = false; setSaveState('error'); setSaveError('The selected agent changed: reopen the file to save.'); return; }
    const content = editContent;
    setSaveState('saving');
    setSaveError(null);
    const stillHere = () => selectedPathRef.current === path && selectedWorkspaceRef.current === workspaceId;
    try {
      const res = await apiFetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: workspaceId, path, content: crlfRef.current ? content.replace(/\n/g, '\r\n') : content, ...(!overwrite && fileMtimeRef.current !== null ? { expectedMtimeMs: fileMtimeRef.current } : {}) }) });
      if (!res.ok) {
        // 409: the agent wrote the file after it was opened. Nothing was saved; the user chooses what to do.
        if (res.status === 409) {
          const info = await res.json().catch(() => ({})) as { deleted?: unknown };
          if (stillHere()) { setSaveState('idle'); setConflict(info.deleted === true ? 'deleted' : 'changed'); }
          return;
        }
        const message = await errorText(res);
        if (stillHere()) { setSaveState('error'); setSaveError(message); }
        return;
      }
      if (!stillHere()) return;
      let saved: { mtimeMs?: unknown } = {};
      try { saved = await res.json() as { mtimeMs?: unknown }; } catch { /* an old server answers { ok: true } only */ }
      if (!stillHere()) return;
      fileMtimeRef.current = typeof saved.mtimeMs === 'number' ? saved.mtimeMs : null;
      setFileContent(content);
      setSaveState('saved');
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500);
    } catch {
      if (stillHere()) { setSaveState('error'); setSaveError('Could not save the file.'); }
    } finally {
      saveBusyRef.current = false;
    }
  }, [selectedPath, selectedWorkspace, fileView.status, editContent, fileContent, tail]);

  // "Load earlier": the 256 KB before what is shown, up to 2 MB in all.
  const loadEarlier = useCallback(async () => {
    const workspaceId = fileWorkspaceRef.current;
    if (!tail || tail.loading || tail.offset <= 0 || !selectedPath || !workspaceId) return;
    const remaining = TAIL_MAX_BYTES - tail.loaded;
    if (remaining < 4096) return;
    const reqId = fileReqRef.current;
    const stale = () => reqId !== fileReqRef.current;
    const end = tail.offset;
    const start = Math.max(0, end - Math.min(TAIL_BYTES, remaining));
    setTail((t) => (t ? { ...t, loading: true, error: null } : t));
    const failed = (message: string) => { if (!stale()) setTail((t) => (t ? { ...t, loading: false, error: message } : t)); };
    try {
      const res = await apiFetch(`/api/workspace?workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(selectedPath)}&offset=${start}&length=${end - start}`);
      if (stale()) return;
      if (!res.ok) { failed(await errorText(res)); return; }
      const data = await res.json() as { content?: unknown; offset?: unknown; length?: unknown };
      if (stale()) return;
      if (typeof data.content !== 'string' || typeof data.offset !== 'number' || typeof data.length !== 'number' || data.offset >= end) {
        failed('Could not load earlier lines.');
        return;
      }
      const chunk = data.content;
      setFileContent((c) => chunk + c);
      setEditContent((c) => chunk + c);
      setTail((t) => (t ? { ...t, offset: data.offset as number, loaded: t.loaded + (data.length as number), loading: false } : t));
    } catch {
      failed('Could not load earlier lines.');
    }
  }, [tail, selectedPath]);

  // Cmd/Ctrl+S saves when Save is enabled; the browser's own save dialog never opens on this page.
  const saveRef = useRef(saveFile);
  saveRef.current = saveFile;
  const canSaveRef = useRef(canSave);
  canSaveRef.current = canSave;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (canSaveRef.current) void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Leaving the page (reload, close tab, address bar) with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /** Runs `run` now, or after the user confirms discarding unsaved edits. */
  const guardUnsaved = useCallback((run: () => void) => {
    if (dirty) setPendingSwitch({ run }); else run();
  }, [dirty]);

  const openNode = useCallback((node: TreeNode) => {
    if (node.absPath === selectedPath && fileView.status !== 'error') return; // already open: keep the edits
    guardUnsaved(() => { void loadFile(node); });
  }, [selectedPath, fileView.status, guardUnsaved, loadFile]);

  const switchWorkspace = useCallback((id: string) => {
    fileAbortRef.current?.abort();
    fileReqRef.current += 1;
    fileWorkspaceRef.current = null;
    releaseMedia();
    setSelectedWorkspace(id);
    setTree([]);
    setTreeLoading(true);
    setTreeError(null);
    setExpanded(new Set());
    setSelectedPath(null);
    setSelectedNode(null);
    setFileView({ status: 'idle' });
    setFileContent('');
    setEditContent('');
    setTail(null);
    setBinaryInfo(null);
    setConflict(false);
    fileMtimeRef.current = null;
    setFocusedIndex(-1);
    setMobileView('tree');
    setSaveState('idle');
    setSaveError(null);
  }, [releaseMedia]);

  // The list reload can move the selection to another agent (the old one is gone): drop the open file with it.
  useEffect(() => {
    if (fileWorkspaceRef.current && fileWorkspaceRef.current !== selectedWorkspace) switchWorkspace(selectedWorkspace);
  }, [selectedWorkspace, switchWorkspace]);

  // Keyboard navigation
  const flatItems = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);
  flatItemsRef.current = flatItems;

  const syncFocusToNode = useCallback((node: TreeNode) => {
    const idx = flatItemsRef.current.findIndex((f) => f.node.relPath === node.relPath);
    if (idx >= 0) {
      setFocusedIndex(idx);
      const el = document.getElementById(`tree-item-${node.relPath.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
      el?.scrollIntoView({ block: 'nearest' });
      // Re-focus the tree container so keyboard nav works
      treeContainerRef.current?.focus();
    }
  }, []);

  const toggleDir = useCallback((relPath: string, node?: TreeNode) => {
    setExpanded((prev) => { const next = new Set(prev); next.has(relPath) ? next.delete(relPath) : next.add(relPath); return next; });
    if (node) syncFocusToNode(node);
  }, [syncFocusToNode]);

  const moveFocus = useCallback((direction: -1 | 1) => {
    const items = flatItemsRef.current;
    if (items.length === 0) return;
    const current = focusedIndex < 0 ? (direction === 1 ? -1 : 0) : focusedIndex;
    const next = Math.max(0, Math.min(current + direction, items.length - 1));
    setFocusedIndex(next);
    const el = document.getElementById(`tree-item-${items[next].node.relPath.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const activateCurrent = useCallback(() => {
    const items = flatItemsRef.current;
    if (focusedIndex < 0 || focusedIndex >= items.length) return;
    const item = items[focusedIndex];
    if (item.node.type === 'directory') {
      toggleDir(item.node.relPath, item.node);
    } else {
      syncFocusToNode(item.node);
      openNode(item.node);
    }
  }, [focusedIndex, toggleDir, openNode, syncFocusToNode]);

  const expandCurrent = useCallback(() => {
    const items = flatItemsRef.current;
    if (focusedIndex < 0 || focusedIndex >= items.length) return;
    const item = items[focusedIndex];
    if (item.node.type === 'directory' && !expanded.has(item.node.relPath)) {
      toggleDir(item.node.relPath, item.node);
    }
  }, [focusedIndex, expanded, toggleDir]);

  const collapseCurrent = useCallback(() => {
    const items = flatItemsRef.current;
    if (focusedIndex < 0 || focusedIndex >= items.length) return;
    const item = items[focusedIndex];
    if (item.node.type === 'directory' && expanded.has(item.node.relPath)) {
      toggleDir(item.node.relPath, item.node);
    }
  }, [focusedIndex, expanded, toggleDir]);

  // Click on tree container focuses it for keyboard
  const handleTreeContainerClick = useCallback(() => {
    treeContainerRef.current?.focus();
  }, []);

  // Resize drag
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragStartX.current = e.clientX; dragStartWidth.current = sidebarWidth;
    setIsDragging(true);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => { const w = Math.max(180, Math.min(600, dragStartWidth.current + e.clientX - dragStartX.current)); setSidebarWidth(w); };
    const onUp = () => setIsDragging(false);
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [isDragging]);

  // The preview HTML only ever comes from renderMarkdownSafe (allow-listed tags, no script, no unsafe URL).
  // marked can throw (deep nesting overflows the stack) or take seconds on a very large file: a file
  // over PREVIEW_MAX_CHARS, or one that fails to render, is shown as source instead of breaking the page.
  const preview = useMemo(() => {
    if (fileView.status !== 'text' || !previewMode) return { html: '', failed: null as string | null };
    if (editContent.length > PREVIEW_MAX_CHARS) return { html: '', failed: 'This file is too large for the preview: showing the source.' };
    try {
      return { html: renderMarkdownSafe(editContent), failed: null };
    } catch {
      return { html: '', failed: 'The preview could not render this file: showing the source.' };
    }
  }, [fileView.status, previewMode, editContent]);
  const previewHtml = preview.html;
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);
  useEffect(() => {
    if (preview.failed) { setPreviewNotice(preview.failed); setPreviewMode(false); }
  }, [preview.failed]);
  useEffect(() => { setPreviewNotice(null); }, [selectedPath]);

  const saveBtnLabel = saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : 'SAVE';
  const lang = selectedNode ? (EXT_LANG[extOf(selectedNode.name)] ?? 'text') : 'text';

  // Responsive breakpoints
  const [isMobile, setIsMobile] = useState<'phone'|'tablet'|'desktop'>('desktop');
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      if (w < 768) setIsMobile('phone');
      else if (w < 1024) setIsMobile('tablet');
      else setIsMobile('desktop');
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // One message for the whole body when there is nothing to browse.
  let bodyState: React.ReactNode = null;
  if (wsLoading) {
    bodyState = null;
  } else if (wsError) {
    bodyState = <StatePanel tone="error" title="Could not load the agent list" message={wsError} action={<Button variant="secondary" size="sm" onClick={() => setWsReload((n) => n + 1)}>Retry</Button>} />;
  } else if (!dockerAvailable) {
    bodyState = <StatePanel tone="error" title="Docker is not running" message="Start Docker to browse agent workspaces." action={<Button variant="secondary" size="sm" onClick={() => setWsReload((n) => n + 1)}>Check again</Button>} />;
  } else if (workspaces.length === 0) {
    bodyState = <StatePanel title="No agents yet" message="Create an agent on the Agents page to browse its workspace here." />;
  } else if (stopped) {
    bodyState = <StatePanel title="This agent is not running. Start it from the Agents page." action={<Button variant="secondary" size="sm" onClick={() => setWsReload((n) => n + 1)}>Check again</Button>} />;
  }

  const selectedName = selectedNode?.name ?? '';
  const showFileActions = selectedPath != null && fileView.status === 'text' && tail === null;
  const downloadWorkspace = fileWorkspaceRef.current ?? selectedWorkspace;
  const downloadUrl = selectedPath != null && downloadWorkspace
    ? `/api/workspace?workspace=${encodeURIComponent(downloadWorkspace)}&path=${encodeURIComponent(selectedPath)}&download=1`
    : null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        {isMobile === 'phone' && mobileView === 'editor' && !bodyState ? (
          <Button variant="ghost" size="sm" onClick={() => setMobileView('tree')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M9 2L4 7l5 5"/></svg>
            BACK
          </Button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'var(--font-serif-stack)', fontSize: 20, letterSpacing: '4px', color: 'var(--violet)' }}>WORKSPACE</span>
            {wsLoading ? (
              <Skeleton width={160} height={24} accent />
            ) : workspaces.length > 0 && (
              <Select
                aria-label="Agent workspace"
                value={selectedWorkspace}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id === selectedWorkspace) return;
                  guardUnsaved(() => switchWorkspace(id));
                }}
                options={workspaces.map((w) => ({ value: w.id, label: w.running ? w.label : `${w.label} (stopped)` }))}
              />
            )}
          </div>
        )}
        {showFileActions && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isMarkdown(selectedName) && (
              <Button variant={previewMode ? 'primary' : 'ghost'} size="sm" onClick={() => setPreviewMode(!previewMode)}>
                {previewMode ? 'EDIT' : 'PREVIEW'}
              </Button>
            )}
            <Button variant={saveState === 'saved' ? 'success' : 'primary'} size="sm" onClick={() => void saveFile()} disabled={!canSave} loading={saveState === 'saving'} title="Save (Cmd/Ctrl+S)">
              {saveBtnLabel}
            </Button>
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {wsLoading ? (
          <div style={{ width: isMobile === 'phone' ? '100%' : sidebarWidth, borderRight: isMobile === 'phone' ? 'none' : '1px solid var(--border)', overflow: 'hidden' }}>
            <TreeSkeleton rows={16} />
          </div>
        ) : bodyState ? bodyState : (
        <>
        {/* Sidebar tree */}
        <div style={{ width: isMobile === 'phone' ? '100%' : isMobile === 'tablet' ? '40%' : sidebarWidth, minWidth: isMobile === 'phone' ? '100%' : isMobile === 'tablet' ? '200px' : sidebarWidth, borderRight: isMobile === 'phone' ? 'none' : '1px solid var(--border)', display: isMobile === 'phone' && mobileView === 'editor' ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {treeError && (
            <div role="alert" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--red)', display: 'flex', flexDirection: 'column', gap: 6, overflowWrap: 'anywhere' }}>
              <span>{treeError}</span>
              {treePaused && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#888' }}>
                  Updates paused.
                  <Button variant="secondary" size="sm" onClick={() => setTreeReload((n) => n + 1)}>Retry</Button>
                </span>
              )}
            </div>
          )}
          <div
            ref={treeContainerRef}
            data-tree-container
            tabIndex={0}
            onClick={handleTreeContainerClick}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                moveFocus(1);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                moveFocus(-1);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                activateCurrent();
              } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                expandCurrent();
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                collapseCurrent();
              }
            }}
            style={{ flex: 1, overflowY: 'auto', paddingTop: 6, paddingBottom: 24, outline: 'none' }}
          >
            {treeLoading ? (
              <TreeSkeleton rows={16} />
            ) : tree.length === 0 ? (
              !treeError && <div style={{ padding: '20px 12px', color: '#555', fontSize: 11 }}>Empty workspace</div>
            ) : flatItems.map((item, index) => (
              <TreeNodeRow
                key={item.node.relPath}
                id={`tree-item-${item.node.relPath.replace(/[^a-zA-Z0-9_-]/g, '_')}`}
                node={item.node}
                depth={item.depth}
                selected={selectedPath}
                expanded={expanded}
                onToggle={(relPath: string) => {
                  const item = flatItems.find(f => f.node.relPath === relPath);
                  toggleDir(relPath, item?.node);
                }}
                onSelect={(node: TreeNode) => {
                  syncFocusToNode(node);
                  openNode(node);
                }}
                focused={index === focusedIndex}
              />
            ))}
          </div>
        </div>

        {/* Resize handle — desktop only */}
        {isMobile === 'desktop' && (
        <div
          onMouseDown={onMouseDown}
          style={{ width: 4, cursor: 'col-resize', background: isDragging ? 'var(--violet)' : 'transparent', transition: isDragging ? 'none' : 'background 0.15s', flexShrink: 0 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#333'; }}
          onMouseLeave={(e) => { if (!isDragging) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        />
        )}

        {/* Editor / Preview */}
        <div style={{ flex: 1, minWidth: 0, display: isMobile === 'phone' && mobileView === 'tree' ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!selectedPath ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: 12 }}>
              Select a file to view or edit
            </div>
          ) : (
            <>
              {/* File meta bar */}
              <div style={{ padding: '6px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, background: 'var(--bg2)' }}>
                <span style={{ fontSize: 11, color: 'var(--violet)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{displayPath(selectedPath, root)}</span>
                {dirty && <span style={{ fontSize: 10, color: 'var(--yellow)', flexShrink: 0 }}>unsaved</span>}
                {rev4aReadOnly && <span style={{ fontSize: 10, color: 'var(--yellow)', flexShrink: 0 }}>Read-only, managed by Rev4a</span>}
                <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>{fileView.status === 'media' ? fileView.kind : lang}</span>
                {fileView.status === 'media' && mediaDims && (
                  <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>{mediaDims.w} x {mediaDims.h}</span>
                )}
                {selectedNode && <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>{fmtSize(selectedNode.size)}</span>}
                {selectedNode && <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>{fmtDate(selectedNode.mtimeMs)}</span>}
                {downloadUrl && (
                  <a className="ui-btn ui-btn--secondary ui-btn--sm ws-download" href={downloadUrl} download>Download</a>
                )}
              </div>
              {fileView.status === 'text' && tail && (
                <div role="status" className="ws-tail-banner">
                  <span>
                    {tail.offset > 0
                      ? `Showing the last ${fmtSize(tail.size - tail.offset)} of ${fmtSize(tail.size)} \u2014 read-only`
                      : `Showing all of ${fmtSize(tail.size)} \u2014 read-only`}
                  </span>
                  {tail.offset > 0 && TAIL_MAX_BYTES - tail.loaded >= 4096 && (
                    <Button variant="secondary" size="sm" loading={tail.loading} onClick={() => void loadEarlier()}>Load earlier</Button>
                  )}
                  {tail.offset > 0 && TAIL_MAX_BYTES - tail.loaded < 4096 && (
                    <span>2 MB are loaded: earlier lines stay on the agent. Download the file to read all of it.</span>
                  )}
                  {tail.error && <span style={{ color: 'var(--red)' }}>{tail.error}</span>}
                </div>
              )}
              {previewNotice && !previewMode && (
                <div role="status" style={{ padding: '6px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>
                  {previewNotice}
                </div>
              )}
              {saveError && (
                <div role="alert" style={{ padding: '6px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--red)', flexShrink: 0, overflowWrap: 'anywhere' }}>
                  {saveError}
                </div>
              )}

              {/* Content */}
              {fileView.status === 'loading' ? (
                <CodeSkeleton lines={18} />
              ) : fileView.status === 'binary' ? (
                <StatePanel
                  title="Preview not available yet"
                  message={`${selectedName} is not a text file, so it cannot be edited here.`}
                  action={<div className="ws-binary-info">{binaryInfo?.label ? `${binaryInfo.label} \u00b7 ` : ''}{fmtSize(binaryInfo?.size ?? selectedNode?.size ?? 0)}</div>}
                />
              ) : fileView.status === 'media' ? (
                <div className="ws-media-pane">
                  {(fileView.kind === 'image' || fileView.kind === 'svg') && (
                    <>
                      <div className="ws-media-toolbar">
                        <Button variant={mediaFit ? 'primary' : 'ghost'} size="sm" onClick={() => setMediaFit(true)}>Fit</Button>
                        <Button variant={mediaFit ? 'ghost' : 'primary'} size="sm" onClick={() => setMediaFit(false)}>1:1</Button>
                      </div>
                      <div className={`ws-media-stage ws-media-checker${mediaFit ? ' is-fit' : ''}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          className={`ws-media-img${mediaFit ? ' is-fit' : ''}`}
                          src={fileView.url}
                          alt={selectedName}
                          onClick={() => setMediaFit((v) => !v)}
                          onLoad={(e) => setMediaDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                          onError={() => setFileView({ status: 'error', message: 'The browser could not display this image.' })}
                        />
                      </div>
                    </>
                  )}
                  {fileView.kind === 'pdf' && (
                    <>
                      {isMobile === 'phone' && (
                        <div className="ws-media-toolbar">
                          <a className="ws-media-link" href={fileView.url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
                        </div>
                      )}
                      <iframe className="ws-media-frame" src={fileView.url} title={selectedName || 'PDF'} />
                    </>
                  )}
                  {fileView.kind === 'audio' && (
                    <div className="ws-media-stage ws-media-center">
                      <div className="ws-media-name">{selectedName}</div>
                      <audio className="ws-media-audio" controls src={fileView.url} />
                    </div>
                  )}
                  {fileView.kind === 'video' && (
                    <div className="ws-media-stage ws-media-center">
                      <video className="ws-media-video" controls playsInline src={fileView.url} />
                    </div>
                  )}
                </div>
              ) : fileView.status === 'error' ? (
                <StatePanel
                  tone="error"
                  title="Could not open this file"
                  message={fileView.message}
                  action={selectedNode && <Button variant="secondary" size="sm" onClick={() => { void loadFile(selectedNode); }}>Retry</Button>}
                />
              ) : fileView.status === 'text' && previewMode ? (
                <div
                  className="ws-md-preview"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : fileView.status === 'text' ? (
                <textarea
                  aria-label="File content"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  spellCheck={false}
                  readOnly={tail !== null || rev4aReadOnly}
                  style={{ flex: 1, resize: 'none', background: 'var(--bg)', color: '#e0e0e0', border: 'none', outline: 'none', padding: '16px 20px', fontSize: 12, fontFamily: 'var(--font-mono-stack)', lineHeight: 1.6, tabSize: 2 }}
                />
              ) : null}
            </>
          )}
        </div>
        </>
        )}
      </div>

      <Modal open={conflict !== false} onClose={() => setConflict(false)} title={conflict === 'deleted' ? 'The file was deleted on the agent' : 'The file changed on the agent'} tone="warning" maxWidth={460}>
        <div className="ws-conflict-text">
          {conflict === 'deleted' ? (
            <>
              {selectedPath ? displayPath(selectedPath, root) : 'This file'}{' '}was deleted by the agent after you opened it. Nothing was saved.
              Overwrite creates it again with your version; Reload shows that it is gone (your edits are discarded).
            </>
          ) : (
            <>
              {selectedPath ? displayPath(selectedPath, root) : 'This file'}{' '}was changed by the agent after you opened it. Nothing was saved.
              Reload to see the agent&apos;s version (your edits are discarded), or overwrite it with yours.
            </>
          )}
        </div>
        <div className="ws-conflict-actions">
          <Button variant="secondary" size="sm" onClick={() => setConflict(false)}>Keep editing</Button>
          <Button variant="secondary" size="sm" onClick={() => { setConflict(false); if (selectedNode) void loadFile(selectedNode); }}>Reload from the agent</Button>
          <Button variant="primary" size="sm" onClick={() => { setConflict(false); void saveFile(true); }}>Overwrite</Button>
        </div>
      </Modal>

      <ConfirmModal
        open={pendingSwitch != null}
        onClose={() => setPendingSwitch(null)}
        onConfirm={() => { const p = pendingSwitch; setPendingSwitch(null); p?.run(); }}
        title="Discard unsaved changes?"
        message={`${selectedPath ? displayPath(selectedPath, root) : 'This file'} has changes that are not saved. Continuing discards them.`}
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        tone="warning"
      />
    </div>
  );
}
