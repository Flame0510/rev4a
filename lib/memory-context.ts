/**
 * The Context page: pure helpers that turn one read of an agent's workspace, made inside its
 * container, into what OpenClaw puts in the agent's prompt. No I/O and no imports here; the route
 * (app/api/memory-context/route.ts) runs the argv built here through lib/docker-exec.ts.
 *
 * The container script is constant text: nothing from a request is ever part of it. It prints one
 * JSON line with sizes and times only, never a file's content.
 */

/** The agent's workspace inside its container (same root as the Workspace page). */
export const CONTEXT_WORKSPACE = '/root/.openclaw/workspace';

/** The agent's config inside its container. */
export const CONTEXT_CONFIG_PATH = '/root/.openclaw/openclaw.json';

/** OpenClaw's defaults (verified on 9.3 and 9.9) when the config sets nothing. */
export const DEFAULT_BOOTSTRAP_MAX_CHARS = 20000;
export const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 60000;

/** Most memory files returned, newest first. */
export const MEMORY_FILES_MAX = 200;

/** Most entries the memory/ walk visits before it stops and flags the list as truncated. */
export const MEMORY_VISIT_MAX = 20000;

/** The `.rev4a` rules file (a read-only mount), relative to the workspace. */
export const RULES_FILE = '.rev4a/AGENTS.md';

export const CONTEXT_TIMEOUT_MS = 20_000;
export const CONTEXT_MAX_BUFFER = 4 * 1024 * 1024;
export const CONTEXT_CACHE_TTL_MS = 30_000;

export interface BootstrapSpec {
  name: string;
  /** Shown next to the file when OpenClaw does not always inject it. */
  note?: string;
  /** A file OpenClaw does not expect to find: its absence is normal, not a "missing file" marker. */
  optional?: boolean;
}

/**
 * The files OpenClaw injects into the prompt, in injection order (verified on 9.9). Blank files are
 * skipped. A missing file other than MEMORY.md gets a one-line "missing file" marker. A sub-agent
 * session injects AGENTS.md only.
 */
export const BOOTSTRAP_FILES: BootstrapSpec[] = [
  { name: 'AGENTS.md' },
  { name: 'SOUL.md' },
  { name: 'IDENTITY.md' },
  { name: 'USER.md' },
  { name: 'BOOTSTRAP.md', optional: true, note: 'Only while pending on a brand-new workspace' },
  { name: 'MEMORY.md', optional: true, note: 'Only when present; left out in sub-agent, cron, group and channel sessions' },
];

/** Workspace files that are NOT injected; listed when present, never counted. */
export const OTHER_FILES = ['TOOLS.md', 'HEARTBEAT.md'];

/**
 * Runs in the container as `node -e <script>`. The workspace root, the config path and the file
 * names are baked in. Symlinks are never followed, anywhere: a bootstrap file that is a symlink is
 * reported as present and linked (size not read), a symlinked `memory` or `.rev4a` folder is
 * reported as linked and not read, and a symlink inside memory/ is skipped.
 *
 * memory/ is walked to depth 3 and at most MEMORY_VISIT_MAX entries are visited; the newest
 * MEMORY_FILES_MAX files by mtime are kept while walking (a bounded array), so folder order never
 * decides which files show. `memoryTruncated` is set when more files exist than are returned, when
 * the visit cap stops the walk, or when a folder lies below the depth limit.
 */
function buildScript(): string {
  const names = JSON.stringify([...BOOTSTRAP_FILES.map((f) => f.name), ...OTHER_FILES]);
  return [
    "const fs=require('fs'),path=require('path');",
    `const ROOT=${JSON.stringify(CONTEXT_WORKSPACE)},CFG=${JSON.stringify(CONTEXT_CONFIG_PATH)},NAMES=${names},RULES=${JSON.stringify(RULES_FILE)};`,
    'const BIG=8*1024*1024;',
    'function info(rel){try{const p=path.join(ROOT,rel),l=fs.lstatSync(p);',
    'if(l.isSymbolicLink())return{exists:true,chars:null,linked:true};',
    'if(!l.isFile())return{exists:false,chars:null};',
    'if(l.size>BIG)return{exists:true,chars:l.size};',
    "const t=fs.readFileSync(p,'utf8');return{exists:true,chars:t.length,blank:t.trim()===''};}catch(e){return{exists:false,chars:null};}}",
    'function realDir(rel){try{const l=fs.lstatSync(path.join(ROOT,rel));return l.isSymbolicLink()?"linked":l.isDirectory()?"dir":"none";}catch(e){return"none";}}',
    'const out={files:NAMES.map(n=>({name:n,...info(n)})),rules:{exists:false,chars:null},memory:[],memoryTruncated:false,memoryLinked:false,config:null};',
    'const rd=realDir(".rev4a");if(rd==="linked")out.rules={exists:true,chars:null,linked:true};else if(rd==="dir")out.rules=info(RULES);',
    `const KEEP=${MEMORY_FILES_MAX},VISIT=${MEMORY_VISIT_MAX};`,
    'let seen=0,stop=false;',
    'const newer=(a,b)=>b.mtimeMs-a.mtimeMs||(a.name<b.name?-1:1);',
    "function walk(rel,depth){let es;try{es=fs.readdirSync(path.join(ROOT,rel),{withFileTypes:true});}catch(e){return;}",
    'for(const e of es){if(stop)return;if(++seen>VISIT){out.memoryTruncated=true;stop=true;return;}',
    'const r=rel+"/"+e.name;',
    'if(e.isSymbolicLink())continue;',
    'if(e.isDirectory()){if(depth<3)walk(r,depth+1);else out.memoryTruncated=true;continue;}',
    'if(!e.isFile())continue;',
    'try{const s=fs.statSync(path.join(ROOT,r));out.memory.push({name:r.slice(7),size:s.size,mtimeMs:Math.round(s.mtimeMs)});',
    'if(out.memory.length>KEEP*2){out.memory.sort(newer);out.memory.length=KEEP;out.memoryTruncated=true;}}catch(x){}}}',
    'const md=realDir("memory");if(md==="linked")out.memoryLinked=true;else if(md==="dir")walk("memory",0);',
    'out.memory.sort(newer);',
    'if(out.memory.length>KEEP){out.memory.length=KEEP;out.memoryTruncated=true;}',
    "try{const c=JSON.parse(fs.readFileSync(CFG,'utf8')),a=(c&&c.agents)||{};",
    'const pick=o=>({perFile:o&&o.bootstrapMaxChars,total:o&&o.bootstrapTotalMaxChars});',
    'const entries={};if(a.entries&&typeof a.entries==="object")for(const k of Object.keys(a.entries))entries[k]=pick(a.entries[k]);',
    'out.config={defaults:pick(a.defaults),entries};}catch(e){}',
    'process.stdout.write(JSON.stringify(out)+"\\n");',
  ].join('\n');
}

export const CONTEXT_SCRIPT = buildScript();

/** The command that follows `docker exec <container>`. */
export const CONTEXT_ARGV = ['node', '-e', CONTEXT_SCRIPT];

// ── Types ────────────────────────────────────────────────────────────────────────────────────

export type LimitSource = 'default' | 'config';

export interface Limit {
  value: number;
  source: LimitSource;
}

export interface Limits {
  perFile: Limit;
  total: Limit;
}

export interface BootstrapFileView {
  name: string;
  /** Path relative to the workspace root, for the Workspace page link. */
  path: string;
  exists: boolean;
  /** Size in characters, or null when the file is missing or a symlink that is not read. */
  chars: number | null;
  /** Characters OpenClaw puts in the prompt, after the per-file and the total caps. */
  injected: number;
  truncated: boolean;
  note?: string;
  optional?: boolean;
  /** A symlink: OpenClaw follows it, Rev4a does not, so the size is unknown and not counted. */
  linked?: boolean;
}

export interface MemoryFileView {
  /** Path under memory/. */
  name: string;
  /** Path relative to the workspace root. */
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ContextView {
  files: BootstrapFileView[];
  totals: {
    injected: number;
    cap: number;
    /** Characters of all present files, before any cap. */
    chars: number;
    truncatedFiles: number;
    /** Linked prompt files whose size is unknown: the total leaves them out. */
    linkedFiles: number;
  };
  limits: Limits;
  /** Workspace files that are not injected (TOOLS.md, HEARTBEAT.md), when present. */
  other: Array<{ name: string; path: string; chars: number | null }>;
  memory: { files: MemoryFileView[]; truncated: boolean; linked: boolean };
  rules: { path: string; exists: boolean; size: number | null; linked: boolean };
}

// ── Raw container output ─────────────────────────────────────────────────────────────────────

interface RawFile { name: string; exists: boolean; chars: number | null; linked?: boolean; blank?: boolean }
interface RawLimits { perFile?: unknown; total?: unknown }
export interface RawContext {
  files: RawFile[];
  rules: { exists: boolean; chars: number | null; linked?: boolean };
  memory: Array<{ name: string; size: number; mtimeMs: number }>;
  memoryTruncated: boolean;
  memoryLinked?: boolean;
  config: { defaults?: RawLimits; entries?: Record<string, RawLimits> } | null;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** The JSON line the script printed; throws when it is missing or has the wrong shape. */
export function parseContextOutput(output: string): RawContext {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) throw new Error('Empty context output');
  const raw = JSON.parse(last) as Partial<RawContext> | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.files) || !Array.isArray(raw.memory) || !raw.rules) {
    throw new Error('Unexpected context output');
  }
  return raw as RawContext;
}

// ── Limits ───────────────────────────────────────────────────────────────────────────────────

function pickLimit(sources: unknown[], fallback: number): Limit {
  for (const v of sources) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const n = Math.floor(v);
    if (n >= 1) return { value: n, source: 'config' };
  }
  return { value: fallback, source: 'default' };
}

/**
 * The effective caps. An agent's own entry (`agents.entries.<id>`) wins over `agents.defaults`, which
 * wins over OpenClaw's built-in defaults. The entry is `main` when it exists, otherwise the only
 * entry; with several entries and no `main`, only the defaults and the built-ins apply.
 */
export function resolveLimits(config: RawContext['config']): Limits {
  const defaults = config?.defaults ?? {};
  const entries = config?.entries ?? {};
  const keys = Object.keys(entries);
  const own = entries.main ?? (keys.length === 1 ? entries[keys[0]] : undefined) ?? {};
  return {
    perFile: pickLimit([own.perFile, defaults.perFile], DEFAULT_BOOTSTRAP_MAX_CHARS),
    total: pickLimit([own.total, defaults.total], DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS),
  };
}

// ── Injection ────────────────────────────────────────────────────────────────────────────────

/**
 * What goes in the prompt: files in injection order, each cut at the per-file cap, and the running
 * total cut at the total cap (a file that comes after the total is spent gets 0).
 */
export function computeInjection(
  chars: Array<number | null>,
  perFile: number,
  total: number,
): Array<{ injected: number; truncated: boolean }> {
  let left = total;
  return chars.map((c) => {
    if (c === null || c <= 0) return { injected: 0, truncated: false };
    const injected = Math.max(0, Math.min(c, perFile, left));
    left -= injected;
    return { injected, truncated: injected < c };
  });
}

/** The view the page shows, from the raw container output. */
export function buildContextView(raw: RawContext): ContextView {
  const limits = resolveLimits(raw.config);
  const byName = new Map(raw.files.map((f) => [f.name, f]));
  const rows = BOOTSTRAP_FILES.map((spec) => {
    const f = byName.get(spec.name);
    return { spec, exists: f?.exists === true, chars: f && isNum(f.chars) ? f.chars : null, linked: f?.linked === true, blank: f?.blank === true };
  });
  const inj = computeInjection(rows.map((r) => (r.blank ? 0 : r.chars)), limits.perFile.value, limits.total.value);
  const files: BootstrapFileView[] = rows.map((r, i) => ({
    name: r.spec.name,
    path: r.spec.name,
    exists: r.exists,
    chars: r.chars,
    injected: inj[i].injected,
    truncated: inj[i].truncated,
    ...(r.spec.note ? { note: r.spec.note } : {}),
    ...(r.spec.optional ? { optional: true } : {}),
    ...(r.linked ? { linked: true } : {}),
  }));
  const other = OTHER_FILES.flatMap((name) => {
    const f = byName.get(name);
    return f?.exists === true ? [{ name, path: name, chars: isNum(f.chars) ? f.chars : null }] : [];
  });
  const memoryFiles: MemoryFileView[] = raw.memory
    .filter((m) => m && typeof m.name === 'string' && m.name && isNum(m.size) && isNum(m.mtimeMs))
    .slice(0, MEMORY_FILES_MAX)
    .map((m) => ({ name: m.name, path: `memory/${m.name}`, size: m.size, mtimeMs: m.mtimeMs }));
  return {
    files,
    totals: {
      injected: inj.reduce((n, x) => n + x.injected, 0),
      cap: limits.total.value,
      chars: files.reduce((n, f) => n + (f.chars ?? 0), 0),
      truncatedFiles: files.filter((f) => f.truncated).length,
      linkedFiles: files.filter((f) => f.linked).length,
    },
    limits,
    other,
    memory: { files: memoryFiles, truncated: raw.memoryTruncated === true || raw.memory.length > MEMORY_FILES_MAX, linked: raw.memoryLinked === true },
    rules: {
      path: RULES_FILE,
      exists: raw.rules.exists === true,
      size: isNum(raw.rules.chars) ? raw.rules.chars : null,
      linked: raw.rules.linked === true,
    },
  };
}

// ── Errors and URLs ──────────────────────────────────────────────────────────────────────────

export interface ContextError { status: number; error: string }

export function contextError(e: unknown, label: string): ContextError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Docker is not available/i.test(msg)) return { status: 503, error: 'Docker is not available' };
  if (/is not running|No such container|is restarting|is paused/i.test(msg)) {
    return { status: 502, error: `Agent ${label} is not running` };
  }
  if (/maxBuffer/i.test(msg)) return { status: 502, error: `Agent ${label} returned too much data` };
  if (/timed out/i.test(msg)) return { status: 502, error: `Agent ${label} did not answer in time` };
  return { status: 502, error: 'Could not read the context files of this agent' };
}

export function contextUrl(agent: string, fresh: boolean): string {
  return `/api/memory-context?agent=${encodeURIComponent(agent)}${fresh ? '&fresh=1' : ''}`;
}

/** The Workspace page link for a file of an agent. */
export function workspaceFileUrl(agent: string, relPath: string): string {
  return `/workspace?agent=${encodeURIComponent(agent)}&file=${encodeURIComponent(relPath)}`;
}

// ── Cache: one read per container for a short time ───────────────────────────────────────────

const MAX_CACHE_ENTRIES = 100;

interface CacheEntry { at: number; view: ContextView }

export class ContextCache {
  private entries = new Map<string, CacheEntry>();
  private ttlMs: number;
  private now: () => number;

  constructor(ttlMs: number = CONTEXT_CACHE_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(container: string): ContextView | null {
    const e = this.entries.get(container);
    if (!e) return null;
    if (this.now() - e.at >= this.ttlMs) {
      this.entries.delete(container);
      return null;
    }
    return e.view;
  }

  set(container: string, view: ContextView): void {
    this.entries.delete(container);
    this.entries.set(container, { at: this.now(), view });
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(container: string): void {
    this.entries.delete(container);
  }
}
