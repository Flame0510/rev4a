'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui';
import { TreeSkeleton } from '../components/Skeleton';

/** One entry of a folder listing (`list=1`). `relPath` is relative to the workspace root. */
export interface TreeEntry {
  path: string;
  relPath: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  /** True for an entry inside a read-only mount (the Rev4a rules). */
  readOnly?: boolean;
}

/** What the tree knows about one folder; the root is the key `''`. */
export interface DirState {
  status: 'loading' | 'ready' | 'error';
  entries: TreeEntry[];
  /** The message of the last failed load. */
  error?: string;
  /** The folder holds more entries than the listing returns. */
  truncated?: boolean;
}

export const READ_ONLY_TITLE = 'Read-only, managed by Rev4a';

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

// ─── File type icon SVGs ──────────────────────────────────────────────────────
const COPPER = 'var(--violet)';

function FolderIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
      <path d="M1.6 4a1.2 1.2 0 0 1 1.2-1.2H6l.8 1h4.4a1.2 1.2 0 0 1 1.2 1.2v5.8a1.2 1.2 0 0 1-1.2 1.2H2.8A1.2 1.2 0 0 1 1.6 10V4Z" fill={COPPER} stroke={COPPER} strokeWidth="0.3" strokeLinejoin="round" opacity="0.85"/>
      {expanded && <line x1="1.6" y1="5.5" x2="12.4" y2="5.5" stroke="#0A0A0B" strokeWidth="0.8"/>}
    </svg>
  );
}

function FileIcon({ name, size }: { name: string; size?: number }) {
  const i = name.lastIndexOf('.');
  const ext = i < 0 ? '' : name.slice(i).toLowerCase();
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

/** A small padlock: this place is read-only. */
function LockBadge() {
  return (
    <span className="ws-lock" role="img" aria-label={READ_ONLY_TITLE} title={READ_ONLY_TITLE}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="1.8" y="4.4" width="6.4" height="4.4" />
        <path d="M3.2 4.4V3a1.8 1.8 0 0 1 3.6 0v1.4" />
      </svg>
    </span>
  );
}

// ─── Rows ─────────────────────────────────────────────────────────────────────
type Row =
  | { kind: 'node'; entry: TreeEntry; depth: number }
  | { kind: 'loading'; depth: number; key: string }
  | { kind: 'error'; depth: number; key: string; relPath: string; message: string }
  | { kind: 'note'; depth: number; key: string; text: string };

/** The visible rows: expanded folders show their children, a spinner while loading, an error row or a note. */
function buildRows(dirs: Record<string, DirState>, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (rel: string, depth: number) => {
    const st = dirs[rel];
    if (!st || (st.status === 'loading' && st.entries.length === 0)) {
      rows.push({ kind: 'loading', depth, key: `loading:${rel}` });
      return;
    }
    if (st.status === 'error' && st.entries.length === 0) {
      rows.push({ kind: 'error', depth, key: `error:${rel}`, relPath: rel, message: st.error ?? 'Could not load this folder.' });
      return;
    }
    for (const e of st.entries) {
      rows.push({ kind: 'node', entry: e, depth });
      if (e.type === 'directory' && expanded.has(e.relPath)) walk(e.relPath, depth + 1);
    }
    if (st.status === 'error') rows.push({ kind: 'error', depth, key: `error:${rel}`, relPath: rel, message: st.error ?? 'Could not load this folder.' });
    if (st.truncated) rows.push({ kind: 'note', depth, key: `more:${rel}`, text: 'Only the first entries are shown.' });
    else if (st.entries.length === 0 && rel !== '') rows.push({ kind: 'note', depth, key: `empty:${rel}`, text: 'Empty folder' });
  };
  walk('', 0);
  return rows;
}

// ─── Tree ─────────────────────────────────────────────────────────────────────
export interface TreeProps {
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  selectedPath: string | null;
  /** Read-only mounts inside the workspace root (absolute paths); an entry inside one gets the lock. */
  readOnlyRoots: string[];
  /** Expand or collapse a folder (the page loads its children the first time). */
  onToggle: (entry: TreeEntry) => void;
  onOpen: (entry: TreeEntry) => void;
  /** Load a folder again (`''` is the root). */
  onRetry: (relPath: string) => void;
}

/** The file tree: rows, selection, read-only badges and keyboard navigation (arrows, Enter, left and right). */
export function Tree({ dirs, expanded, selectedPath, readOnlyRoots, onToggle, onOpen, onRetry }: TreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  /** The row the keyboard is on, by relPath: it survives a refresh that adds or removes rows. */
  const [focusedRel, setFocusedRel] = useState<string | null>(null);

  const rows = useMemo(() => buildRows(dirs, expanded), [dirs, expanded]);
  const nodes = useMemo(() => rows.filter((r): r is Extract<Row, { kind: 'node' }> => r.kind === 'node'), [rows]);
  const focusedIndex = focusedRel === null ? -1 : nodes.findIndex((r) => r.entry.relPath === focusedRel);

  const root = dirs[''];
  const scrollTo = useCallback((rel: string) => { rowEls.current.get(rel)?.scrollIntoView({ block: 'nearest' }); }, []);

  useEffect(() => { if (focusedRel !== null && focusedIndex < 0) setFocusedRel(null); }, [focusedRel, focusedIndex]);

  const move = (direction: -1 | 1) => {
    if (nodes.length === 0) return;
    const from = focusedIndex < 0 ? (direction === 1 ? -1 : 0) : focusedIndex;
    const next = nodes[Math.max(0, Math.min(from + direction, nodes.length - 1))];
    setFocusedRel(next.entry.relPath);
    scrollTo(next.entry.relPath);
  };

  const isReadOnly = (e: TreeEntry) => e.readOnly === true || readOnlyRoots.some((d) => e.path === d || e.path.startsWith(`${d}/`));

  const activate = (entry: TreeEntry) => {
    setFocusedRel(entry.relPath);
    containerRef.current?.focus();
    if (entry.type === 'directory') onToggle(entry); else onOpen(entry);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const item = focusedIndex >= 0 ? nodes[focusedIndex].entry : null;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (item) activate(item); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (item && item.type === 'directory' && !expanded.has(item.relPath)) onToggle(item); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (item && item.type === 'directory' && expanded.has(item.relPath)) onToggle(item); }
  };

  let body: React.ReactNode;
  if (!root || (root.status === 'loading' && root.entries.length === 0)) {
    body = <TreeSkeleton rows={16} />;
  } else if (root.status === 'error' && root.entries.length === 0) {
    body = (
      <div role="alert" className="ws-tree-note ws-tree-note--error" style={{ paddingLeft: 12 }}>
        <span>{root.error ?? 'Could not load the file list.'}</span>
        <Button variant="secondary" size="sm" onClick={() => onRetry('')}>Retry</Button>
      </div>
    );
  } else if (root.entries.length === 0) {
    body = <div className="ws-tree-note" style={{ padding: '20px 12px' }}>Empty workspace</div>;
  } else {
    body = rows.map((row) => {
      const pad = 8 + row.depth * 14;
      if (row.kind === 'loading') {
        return (
          <div key={row.key} role="status" className="ws-tree-note" style={{ paddingLeft: pad + 16 }}>
            <span className="ui-spinner ws-tree-spinner" aria-hidden="true" />
            Loading...
          </div>
        );
      }
      if (row.kind === 'error') {
        return (
          <div key={row.key} role="alert" className="ws-tree-note ws-tree-note--error" style={{ paddingLeft: pad + 16 }}>
            <span>{row.message}</span>
            <Button variant="secondary" size="sm" onClick={() => onRetry(row.relPath)}>Retry</Button>
          </div>
        );
      }
      if (row.kind === 'note') {
        return <div key={row.key} className="ws-tree-note" style={{ paddingLeft: pad + 16 }}>{row.text}</div>;
      }
      const entry = row.entry;
      const isDir = entry.type === 'directory';
      const isExp = isDir && expanded.has(entry.relPath);
      const selected = selectedPath === entry.path;
      const readOnly = isReadOnly(entry);
      return (
        <button
          key={entry.relPath}
          ref={(el) => { if (el) rowEls.current.set(entry.relPath, el); else rowEls.current.delete(entry.relPath); }}
          type="button"
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={isDir ? isExp : undefined}
          aria-selected={selected}
          tabIndex={-1}
          className={`ws-tree-row${isDir ? ' is-dir' : ''}${selected ? ' is-selected' : ''}${entry.relPath === focusedRel ? ' is-focused' : ''}`}
          style={{ paddingLeft: pad }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => activate(entry)}
        >
          {isDir ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill={COPPER} style={{ flexShrink: 0, transition: 'transform 0.15s', transform: isExp ? 'rotate(90deg)' : 'none', opacity: 0.7 }}>
              <path d="M3 2l4 3-4 3z"/>
            </svg>
          ) : (
            <span style={{ width: 10, flexShrink: 0 }} />
          )}
          {isDir ? <FolderIcon expanded={isExp} /> : <FileIcon name={entry.name} />}
          <span className="ws-tree-name">{entry.name}</span>
          {readOnly && <LockBadge />}
          {!isDir && entry.size > 0 && <span className="ws-tree-size">{fmtSize(entry.size)}</span>}
        </button>
      );
    });
  }

  return (
    <div
      ref={containerRef}
      data-tree-container
      role="tree"
      aria-label="Files"
      tabIndex={0}
      className="ws-tree"
      onClick={() => containerRef.current?.focus()}
      onKeyDown={onKeyDown}
    >
      {body}
    </div>
  );
}
