import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Display names of agent containers.
 *
 * The name an agent is shown by is the container's `AGENT_NAME` env (the Agents page
 * reads the same). One `docker inspect` answers for many containers, and the result is
 * cached for a short time on `globalThis` so pages that poll do not spawn it each time.
 * The template prints ONLY AGENT_NAME, never the rest of the env (it holds the gateway token).
 */

const TTL_MS = 15_000;
const INSPECT_TIMEOUT_MS = 8000;

/** The `docker inspect --format` template: container name, then a tab and `AGENT_NAME=value` when set. */
export const AGENT_NAME_INSPECT_FORMAT =
  '{{.Name}}{{range .Config.Env}}{{$p := split . "="}}{{if eq (index $p 0) "AGENT_NAME"}}\t{{.}}{{end}}{{end}}';

/** Parse the output of `docker inspect --format AGENT_NAME_INSPECT_FORMAT`: container name to display name. Unset or blank names are left out. */
export function parseAgentNames(stdout: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of stdout.trim().split('\n')) {
    const [cname, ...vars] = line.split('\t');
    const v = vars.find((e) => e.startsWith('AGENT_NAME='));
    const display = v ? v.slice('AGENT_NAME='.length).trim() : '';
    const container = (cname ?? '').trim().replace(/^\//, '');
    if (container && display) names.set(container, display);
  }
  return names;
}

interface Entry { name: string | null; at: number; seen: number }
const g = globalThis as typeof globalThis & { __rev4aAgentNameMap?: Map<string, Entry> };
const MAX_AGE_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

/** A container name Docker accepts (and nothing a command line could misread). */
export const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function store(): Map<string, Entry> {
  return (g.__rev4aAgentNameMap ??= new Map());
}

function prune(now: number): void {
  const m = store();
  for (const [k, e] of m) if (now - e.seen > MAX_AGE_MS) m.delete(k);
  if (m.size > MAX_ENTRIES) {
    const oldest = [...m.entries()].sort((x, y) => x[1].seen - y[1].seen).slice(0, m.size - MAX_ENTRIES);
    for (const [k] of oldest) m.delete(k);
  }
}

/**
 * Container name to display name for the given containers. A container without AGENT_NAME
 * (or one that Docker does not know) is simply absent from the map: callers fall back to the
 * container name. Each container has its own cache entry (15 s); only missing or expired ones
 * are inspected, in one `docker inspect`. A missing container is remembered as "no name" for
 * the same time. Names that are not valid container names are dropped, never passed to Docker.
 */
export async function getAgentDisplayNames(containers: string[], opts: { fresh?: boolean } = {}): Promise<Map<string, string>> {
  const wanted = [...new Set(containers.map((c) => c.trim()).filter((c) => CONTAINER_NAME_RE.test(c)))].sort();
  const result = new Map<string, string>();
  if (!wanted.length) return result;
  const now = Date.now();
  const m = store();
  const stale = wanted.filter((c) => {
    const e = m.get(c);
    return opts.fresh || !e || now - e.at >= TTL_MS;
  });
  if (stale.length) {
    let out: string | null = null;
    try {
      ({ stdout: out } = await execFileAsync(
        'docker',
        ['inspect', '--format', AGENT_NAME_INSPECT_FORMAT, ...stale],
        { encoding: 'utf8', timeout: INSPECT_TIMEOUT_MS },
      ));
    } catch (e) {
      // `docker inspect` still prints the containers it found when one is missing (exit 1).
      const partial = (e as { stdout?: string }).stdout;
      if (typeof partial === 'string' && partial.trim()) out = partial;
    }
    if (out !== null) {
      const names = parseAgentNames(out);
      for (const c of stale) m.set(c, { name: names.get(c) ?? null, at: now, seen: now });
    }
    // On a total failure the old entries (if any) are kept and served; nothing is cached for new ones.
  }
  for (const c of wanted) {
    const e = m.get(c);
    if (e) { e.seen = now; if (e.name) result.set(c, e.name); }
  }
  prune(now);
  return result;
}

/** The label to show for an agent: its display name, else the container name. */
export function agentLabel(displayName: string | null | undefined, container: string | null | undefined, fallback = 'agent'): string {
  return displayName?.trim() || container || fallback;
}

/** The cached display name of a container, or null: never runs Docker, so it is safe in synchronous code. */
export function cachedAgentName(container: string): string | null {
  const e = g.__rev4aAgentNameMap?.get(container);
  return e && Date.now() - e.at < TTL_MS ? e.name : null;
}

/** `Name (container)` for an error text when the name is cached, else the container name alone. */
export function describeAgent(container: string): string {
  const name = cachedAgentName(container);
  return name && name !== container ? `${name} (${container})` : container;
}

const CONTAINER_RE = /(?<![A-Za-z0-9_.-])agent_[0-9a-f]{8}(?![A-Za-z0-9_-])/g;

/** Container names mentioned in a text (the `agent_<8 hex>` pattern Rev4a gives its containers). */
export function containersInText(text: string): string[] {
  return [...new Set(text.match(CONTAINER_RE) ?? [])];
}

/** Rewrite a stored message for display: each known container name becomes `Name (container)`. The stored text is not touched. */
export function nameContainersInText(text: string, names: Map<string, string>): string {
  return text.replace(CONTAINER_RE, (c) => {
    const n = names.get(c);
    return n && n !== c ? `${n} (${c})` : c;
  });
}
