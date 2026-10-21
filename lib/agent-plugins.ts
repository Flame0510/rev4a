/**
 * The Plugins page: pure helpers that turn `openclaw plugins list --json`, run inside an agent
 * container, into the compact list the page shows. No I/O and no imports here; the route runs
 * the command.
 */

/** The command that follows `docker exec <container>`. Works without the gateway. */
export const PLUGINS_LIST_ARGV = ['openclaw', 'plugins', 'list', '--json'];

/** The CLI needs a few seconds under emulation. */
export const PLUGINS_TIMEOUT_MS = 60_000;

/** The CLI output is large with many plugins (each lists its tools and hooks). */
export const PLUGINS_MAX_BUFFER = 16 * 1024 * 1024;

/** A longer description is cut; a longer list is cut and flagged `truncated`. */
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_PLUGINS = 2000;

export interface AgentPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  status: string;
  origin: string;
  /** How many tools the plugin registers. */
  tools: number;
  hooks: number;
  channels: string[];
  providers: string[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/** One plugin entry in the compact shape, or null when it has no usable id. */
export function compactPlugin(raw: unknown): AgentPlugin | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id).trim();
  if (!id) return null;
  const enabled = p.enabled === true;
  return {
    id,
    name: str(p.name).trim() || id,
    version: str(p.version).trim(),
    description: str(p.description).trim().slice(0, MAX_DESCRIPTION_CHARS),
    enabled,
    status: str(p.status).trim() || (enabled ? 'enabled' : 'disabled'),
    origin: str(p.origin).trim(),
    tools: count(p.toolNames),
    hooks: count(p.hookNames),
    channels: strList(p.channelIds),
    providers: strList(p.providerIds),
  };
}

/** Enabled first, then by name (case-insensitive), then by id. */
export function sortPlugins(list: AgentPlugin[]): AgentPlugin[] {
  return [...list].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const byName = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    return byName !== 0 ? byName : a.id.localeCompare(b.id, 'en');
  });
}

/** The end index (exclusive) of the balanced `{...}` that starts at `start`, or -1. Strings are skipped. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Candidates tried before giving up: log lines with a brace in them are rare. */
const MAX_CANDIDATES = 25;

/**
 * The outermost JSON object in the output that parses and holds a `plugins` array. The CLI may
 * print log lines before and after the JSON, and a log line may itself contain braces.
 */
function findPluginsObject(text: string): unknown[] | null {
  let from = 0;
  for (let tries = 0; tries < MAX_CANDIDATES; tries++) {
    const start = text.indexOf('{', from);
    if (start < 0) return null;
    const end = objectEnd(text, start);
    if (end > 0) {
      try {
        const data = JSON.parse(text.slice(start, end)) as { plugins?: unknown } | null;
        if (data && typeof data === 'object' && Array.isArray(data.plugins)) return data.plugins;
      } catch { /* not the JSON: try the next brace */ }
    }
    from = start + 1;
  }
  return null;
}

export interface ParsedPlugins {
  plugins: AgentPlugin[];
  /** The list was cut at MAX_PLUGINS. */
  truncated: boolean;
}

/**
 * Parse the output of `openclaw plugins list --json`. Log lines before and after the JSON are
 * tolerated. Output with no object holding a `plugins` array throws. A plugin without an id is
 * left out, a repeated id keeps its first entry, and the list is capped at MAX_PLUGINS.
 */
export function parsePluginsList(output: string): ParsedPlugins {
  const text = typeof output === 'string' ? output.trim() : '';
  if (!text) throw new Error('The agent returned no plugin list');
  const raw = findPluginsObject(text);
  if (!raw) throw new Error('The agent returned an unreadable plugin list');
  const seen = new Set<string>();
  const out: AgentPlugin[] = [];
  for (const entry of raw) {
    const p = compactPlugin(entry);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  const truncated = out.length > MAX_PLUGINS;
  const sorted = sortPlugins(out);
  return { plugins: truncated ? sorted.slice(0, MAX_PLUGINS) : sorted, truncated };
}

/** The URL the page asks. `fresh` is only for the request a Reload or Retry click causes. */
export function pluginsUrl(agent: string, fresh: boolean): string {
  return `/api/plugins?agent=${encodeURIComponent(agent)}${fresh ? '&fresh=1' : ''}`;
}

export interface PluginsError { status: number; error: string }

/**
 * An error from the CLI run, as a short response. Raw stderr, paths and tokens never leave the
 * server: the route logs the original and sends this.
 */
export function pluginsError(e: unknown, label: string): PluginsError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Docker is not available/i.test(msg)) return { status: 503, error: 'Docker is not available' };
  if (/is not running|No such container|is restarting|is paused/i.test(msg)) {
    return { status: 502, error: `Agent ${label} is not running` };
  }
  if (/timed out|maxBuffer/i.test(msg)) return { status: 502, error: `Agent ${label} did not answer in time` };
  if (/unknown command|unknown option|too many arguments|invalid command|executable file not found|failed to run command|No such file or directory/i.test(msg)) {
    return { status: 502, error: "This agent's OpenClaw cannot list plugins (update the agent)" };
  }
  return { status: 500, error: 'Could not list plugins' };
}

// ── Cache: one list per container for a short time ─────────────────────────────────────────────

export const PLUGINS_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;

export interface CachedPlugins { plugins: AgentPlugin[]; truncated: boolean }
interface CacheEntry extends CachedPlugins { at: number }

export class PluginsCache {
  private entries = new Map<string, CacheEntry>();
  private ttlMs: number;
  private now: () => number;

  constructor(ttlMs: number = PLUGINS_CACHE_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(container: string): CachedPlugins | null {
    const e = this.entries.get(container);
    if (!e) return null;
    if (this.now() - e.at >= this.ttlMs) {
      this.entries.delete(container);
      return null;
    }
    return e;
  }

  set(container: string, value: CachedPlugins): void {
    this.entries.delete(container);
    this.entries.set(container, { at: this.now(), ...value });
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
