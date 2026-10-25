// Pure session logic shared by the hook, the strategies, the tree and the components.
// Self-contained on purpose (type imports only): scripts/test-lineage-ui.mjs runs it in Node.
import type {
  AgentOption,
  FilterConfig,
  Period,
  Session,
  SessionEvent,
  SessionState,
  TreeNode,
} from '../types';

export const PERIOD_MS: Record<Exclude<Period, 'all'>, number> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '6h': 21_600_000,
  '1d': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};

export const DEFAULT_PERIOD: Period = '1d';

/** Periods removed from the toolbar whose old links keep working: the nearest period that still contains them. */
const LEGACY_PERIODS: Record<string, Period> = { '3d': '7d', '15d': '30d' };

/** A `?period=` or stored value to a period; null when it is not one (the caller keeps its default). */
export function parsePeriod(raw: string | null | undefined): Period | null {
  if (!raw) return null;
  if (raw === 'all') return 'all';
  if (Object.prototype.hasOwnProperty.call(PERIOD_MS, raw)) return raw as Period;
  if (Object.prototype.hasOwnProperty.call(LEGACY_PERIODS, raw)) return LEGACY_PERIODS[raw];
  return null;
}

/** The period to start with: the URL wins over the remembered one, which wins over the default. */
export function resolvePeriod(urlValue: string | null | undefined, storedValue: string | null | undefined): Period {
  return parsePeriod(urlValue) ?? parsePeriod(storedValue) ?? DEFAULT_PERIOD;
}

/** The periods shorter than a day: their window moves fast enough that a clock must re-evaluate it. */
export function isShortPeriod(period: Period): boolean {
  return period === '15m' || period === '1h' || period === '6h';
}

/** How a page uses the dashboard hook: which period it starts on and whether the choice is remembered. */
export interface DashboardOptions {
  defaultPeriod?: Period;
  rememberPeriod?: boolean;
}

/** The home page passes nothing: period 7d, nothing stored. Lineage passes { defaultPeriod: '1d', rememberPeriod: true }. */
export function resolveDashboardOptions(opts: DashboardOptions = {}): Required<DashboardOptions> {
  return { defaultPeriod: opts.defaultPeriod ?? '7d', rememberPeriod: opts.rememberPeriod === true };
}

/**
 * The period to start on: the URL wins over the remembered one, which wins over the default.
 * `readStored` is only called when the page remembers its period.
 */
export function startPeriod(
  urlValue: string | null | undefined,
  readStored: () => string | null | undefined,
  opts: DashboardOptions = {},
): Period {
  const { defaultPeriod, rememberPeriod } = resolveDashboardOptions(opts);
  const fromUrl = parsePeriod(urlValue);
  if (fromUrl) return fromUrl;
  if (!rememberPeriod) return defaultPeriod;
  return parsePeriod(readStored()) ?? defaultPeriod;
}

/** The URL of a filter: every value that is the default is left out. */
export function filterToParams(filter: FilterConfig, defaultPeriod: Period = '7d'): URLSearchParams {
  const p = new URLSearchParams();
  if (filter.agent !== 'all') p.set('agent', filter.agent);
  if (filter.period !== defaultPeriod) p.set('period', filter.period);
  if (filter.showOnlyActive) p.set('active', '1');
  if (!filter.showCron) p.set('cron', '0');
  return p;
}

// ── Time ───────────────────────────────────────────────────────────────────

/** Any stored time as milliseconds: values below 1e11 can only be seconds. null when absent. */
export function toMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : n;
}

// ── Identity ───────────────────────────────────────────────────────────────

export function makeUid(container: string, key: string): string {
  return `${container}|${key}`;
}

/** Splits a uid at the first '|' (container names have none). null when it is not a uid. */
export function parseUid(uid: string | null | undefined): { container: string; key: string } | null {
  const text = String(uid ?? '');
  const at = text.indexOf('|');
  if (at <= 0 || at === text.length - 1) return null;
  return { container: text.slice(0, at), key: text.slice(at + 1) };
}

// ── State ──────────────────────────────────────────────────────────────────

/** What a session is doing now, from OpenClaw's own status. A row of a gone container is not working. */
export function sessionState(session: Pick<Session, 'status' | 'gone_at'>): SessionState {
  switch (session.status) {
    case 'running':
      return session.gone_at ? 'idle' : 'working';
    case 'failed':
      return 'error';
    case 'aborted':
      return 'aborted';
    case 'done':
      return 'done';
    default:
      return 'idle';
  }
}

export function isSessionActive(session: Pick<Session, 'status' | 'gone_at'>): boolean {
  return sessionState(session) === 'working';
}

export function isCronSession(session: Pick<Session, 'kind' | 'session_key' | 'cron_job_id'>): boolean {
  return (
    session.kind === 'cron' ||
    session.kind === 'cron_run' ||
    Boolean(session.cron_job_id) ||
    /^agent:[^:]+:cron:/.test(session.session_key)
  );
}

// ── Labels ─────────────────────────────────────────────────────────────────

/** A label worth showing: not empty, not a bare uuid, not a raw session key. */
function normalizeDisplayLabel(value: string | null | undefined): string {
  const label = String(value ?? '').trim();
  if (!label) return '';
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(label)) return '';
  if (/^agent:[a-z0-9_.-]+(:[a-z0-9_.-]+)*$/i.test(label)) return '';
  if (/^(dashboard|explicit|subagent|cron|session):[0-9a-z_.:-]+$/i.test(label)) return '';
  return label;
}

function short(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '').slice(0, 6);
}

/**
 * The name of a session: its label when it has a real one, else a name from the kind of key
 * (agent:<id>:main, :subagent:<uuid>, :cron:<job>, :cron:<job>:run:<session>, dashboard:<uuid>,
 * explicit:<name>, or a bare uuid).
 */
export function deriveSessionDisplayLabel(
  session: Pick<Session, 'session_key' | 'label' | 'kind' | 'cron_job_id'>,
): string {
  const direct = normalizeDisplayLabel(session.label);
  if (direct) return direct;

  const key = session.session_key || '';
  const rest = key.replace(/^agent:[^:]+:/, '');
  if (session.kind === 'main' || rest === 'main') return 'main';

  const run = /^cron:[^:]+:run:(.+)$/.exec(rest);
  if (session.kind === 'cron_run' || run) return `Cron run ${short(run ? run[1] : rest)}`;
  const cron = /^cron:([^:]+)/.exec(rest);
  if (session.kind === 'cron' || cron) return `Cron ${short(cron ? cron[1] : session.cron_job_id ?? rest)}`;

  if (session.kind === 'subagent' || rest.startsWith('subagent:')) {
    return `Sub-agent ${short(rest.replace(/^subagent:/, ''))}`;
  }
  if (session.kind === 'dashboard' || rest.startsWith('dashboard:')) {
    return `Dashboard ${short(rest.replace(/^dashboard:/, ''))}`;
  }
  if (session.kind === 'explicit' || rest.startsWith('explicit:')) {
    const name = rest.replace(/^explicit:/, '');
    return name.length > 24 ? `Explicit ${short(name)}` : `Explicit ${name}`;
  }
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(rest)) return `Session ${short(rest)}`;
  return rest ? (rest.length > 24 ? `${rest.slice(0, 23)}…` : rest) : 'session';
}

// ── Agents ─────────────────────────────────────────────────────────────────

/** The toolbar's agents: the known containers, then containers that only have sessions left (removed agents). */
export function buildAgentOptions(
  agents: Array<{ container: string; label: string; running: boolean }>,
  sessions: Session[],
): AgentOption[] {
  const out: AgentOption[] = agents.map((a) => ({ value: a.container, label: a.label, running: a.running }));
  const known = new Set(out.map((a) => a.value));
  for (const s of sessions) {
    if (!s.container || known.has(s.container)) continue;
    known.add(s.container);
    out.push({ value: s.container, label: `${s.agent_name || s.container} (removed)`, running: false });
  }
  return out;
}

/**
 * Maps the `?agent=` value to a container. Old links carry a display name: it is matched to a
 * container, and anything unknown falls back to 'all'.
 */
export function resolveAgentFilter(
  value: string | null | undefined,
  agents: AgentOption[],
  sessions: Array<Pick<Session, 'container' | 'agent_name'>> = [],
): string {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'all') return 'all';
  if (agents.some((a) => a.value === raw)) return raw;
  const lower = raw.toLowerCase();
  const byName = agents.find((a) => a.label.toLowerCase() === lower || a.value.toLowerCase() === lower);
  if (byName) return byName.value;
  // /api/agents may be down: the session rows carry the agent's name too.
  const bySession = sessions.find(
    (s) => s.container && (s.container === raw || (s.agent_name ?? '').toLowerCase() === lower || s.container.toLowerCase() === lower),
  );
  return bySession ? bySession.container : 'all';
}

// ── Filters ────────────────────────────────────────────────────────────────

export function periodCutoff(period: Period, now = Date.now()): number {
  return period === 'all' ? 0 : now - PERIOD_MS[period];
}

export function filterSessions(sessions: Session[], config: FilterConfig, now = Date.now()): Session[] {
  const cutoff = periodCutoff(config.period, now);
  return sessions.filter((s) => {
    if (config.agent !== 'all' && s.container !== config.agent) return false;
    if (config.showOnlyActive && !isSessionActive(s)) return false;
    if (!config.showCron && isCronSession(s)) return false;
    if (cutoff && !isSessionActive(s)) {
      const latest = Math.max(Number(s.started_at ?? 0), Number(s.updated_at ?? 0));
      if (latest < cutoff) return false;
    }
    return true;
  });
}

/**
 * The parent that draws an edge: only a real spawn ('spawn') or a cron run under its job ('cron').
 * A navigation parent ('nav') is not lineage; a session with one hangs from its container's main.
 */
export function lineageParentUid(s: Pick<Session, 'parent_uid' | 'parent_kind'>): string | null {
  return s.parent_uid && (s.parent_kind === 'spawn' || s.parent_kind === 'cron') ? s.parent_uid : null;
}

/**
 * The visible sessions plus every ancestor along spawn/cron edges, so a kept sub-agent keeps its
 * path to main. With cron hidden (`showCron: false`) cron job and run rows are not brought back:
 * the sub-agent of a cron run then hangs from main (buildSessionTree marks it `hint`).
 */
export function expandWithParents(all: Session[], visible: Session[], opts: { showCron?: boolean } = {}): Session[] {
  if (!visible.length) return [];
  const showCron = opts.showCron !== false;
  const byUid = new Map(all.map((s) => [s.uid, s]));
  const included = new Set<string>();
  for (const s of visible) {
    let cur: Session | undefined = s;
    while (cur && !included.has(cur.uid)) {
      if (!showCron && cur !== s && isCronSession(cur)) break;
      included.add(cur.uid);
      const parent = lineageParentUid(cur);
      cur = parent ? byUid.get(parent) : undefined;
    }
  }
  return all.filter((s) => included.has(s.uid));
}

// ── Events ─────────────────────────────────────────────────────────────────

function eventContainer(event: SessionEvent): string {
  if (event.container) return event.container;
  const data = event.data;
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const c = (parsed as { container?: unknown } | null)?.container;
    return typeof c === 'string' ? c : '';
  } catch {
    return '';
  }
}

/** Gives an event its container, the agent's name and the session's name, from the sessions it belongs to. */
export function decorateEvents(events: SessionEvent[], sessions: Session[]): SessionEvent[] {
  const byUid = new Map(sessions.map((s) => [s.uid, s]));
  const byKey = new Map<string, Session>();
  for (const s of sessions) if (!byKey.has(s.session_key)) byKey.set(s.session_key, s);
  return events.map((e) => {
    const key = e.session_id ?? '';
    const container = eventContainer(e);
    const session = (container ? byUid.get(makeUid(container, key)) : undefined) ?? (container ? undefined : byKey.get(key));
    const label = session
      ? deriveSessionDisplayLabel(session)
      : deriveSessionDisplayLabel({ session_key: key, label: e.session_label ?? e.label ?? null, kind: '', cron_job_id: null });
    return {
      ...e,
      ts: toMs(e.ts) ?? undefined,
      container: container || session?.container,
      agent_name: e.agent_name || session?.agent_name || undefined,
      session_label: key === 'system' ? 'system' : label,
    };
  });
}

export function eventMatchesFilter(
  event: SessionEvent,
  config: FilterConfig,
  visible: Session[],
  now = Date.now(),
): boolean {
  const key = event.session_id ?? '';
  if (config.agent !== 'all' && event.container !== config.agent) return false;
  if (!config.showCron && /^agent:[^:]+:cron:/.test(key)) return false;
  const cutoff = periodCutoff(config.period, now);
  if (cutoff && Number(event.ts ?? 0) < cutoff) return false;
  if (!visible.length && !config.showOnlyActive) return true;
  return visible.some((s) => s.session_key === key && (!event.container || s.container === event.container));
}

// ── Tree ───────────────────────────────────────────────────────────────────

function sortKey(s: Session): number {
  return Number(s.started_at ?? s.updated_at ?? 0);
}

/**
 * container → main → sessions → sub-agents (any depth) → cron runs. A session whose parent is
 * missing (or would make a loop) hangs from main, or from the container when there is no main.
 */
export function buildSessionTree(sessions: Session[], agents: AgentOption[], filter: string): TreeNode {
  const root: TreeNode = { uid: '__root__', name: '', state: 'idle', _virtualRoot: true, children: [] };
  const visible = filter === 'all' ? sessions : sessions.filter((s) => s.container === filter);

  const groups = new Map<string, Session[]>();
  for (const s of visible) {
    if (!s.uid) continue;
    if (!groups.has(s.container)) groups.set(s.container, []);
    groups.get(s.container)!.push(s);
  }
  const order = [
    ...agents.map((a) => a.value).filter((c) => groups.has(c)),
    ...[...groups.keys()].filter((c) => !agents.some((a) => a.value === c)).sort(),
  ];

  for (const container of order) {
    const list = groups.get(container)!;
    const agent = agents.find((a) => a.value === container);
    const stopped = agent ? !agent.running : list.every((s) => Boolean(s.gone_at));
    const agentNode: TreeNode = {
      uid: `__agent__:${container}`,
      name: agent?.label ?? (list.find((s) => s.agent_name)?.agent_name || container),
      state: 'idle',
      container,
      stopped,
      _agentNode: true,
      children: [],
    };
    const nodes = new Map<string, TreeNode>();
    for (const s of list) {
      nodes.set(s.uid, {
        uid: s.uid,
        name: deriveSessionDisplayLabel(s),
        state: sessionState(s),
        kind: s.kind,
        container,
        model: s.model,
        cost_usd: s.cost_usd,
        children: [],
      });
    }
    const main = list.find((s) => s.kind === 'main') ?? list.find((s) => /^agent:[^:]+:main$/.test(s.session_key));
    const mainNode = main ? nodes.get(main.uid) : undefined;
    const byUid = new Map(list.map((s) => [s.uid, s]));
    const loops = (s: Session): boolean => {
      const seen = new Set<string>([s.uid]);
      let cur = lineageParentUid(s) ? byUid.get(lineageParentUid(s)!) : undefined;
      while (cur) {
        if (seen.has(cur.uid)) return true;
        seen.add(cur.uid);
        const next = lineageParentUid(cur);
        cur = next ? byUid.get(next) : undefined;
      }
      return false;
    };

    if (mainNode) agentNode.children!.push(mainNode);
    for (const s of [...list].sort((a, b) => sortKey(a) - sortKey(b))) {
      if (main && s.uid === main.uid) continue;
      const node = nodes.get(s.uid)!;
      const edge = lineageParentUid(s);
      const parent =
        edge && edge !== s.uid && nodes.has(edge) && !loops(s)
          ? nodes.get(edge)!
          : (mainNode ?? agentNode);
      // A real spawn whose parent is a cron run that is not drawn (cron hidden).
      const parentKey = edge ? parseUid(edge)?.key : undefined;
      if (edge && !nodes.has(edge) && parentKey && /^agent:[^:]+:cron:/.test(parentKey)) node.hint = 'from a cron run';
      parent.children!.push(node);
    }
    root.children!.push(agentNode);
  }
  return root;
}

// --- Lineage graph layout ---------------------------------------------------------------------
// Deterministic and measured by character count (the graph font is monospace), so a test can
// prove that no two label boxes overlap. The component only draws what this computes.

/** A label longer than this is cut with an ellipsis; the tooltip keeps the full text. */
export const LABEL_MAX_CHARS = 24;
/** Width of one character of the 10px monospace graph font. */
export const LABEL_CHAR_WIDTH = 6.2;
/** Vertical room of one node: circle, label line and cost line, plus a gap. */
export const NODE_BLOCK_HEIGHT = 52;
/** Free space kept between the label columns of two depths. */
export const DEPTH_GAP = 36;
/** Label and cost line below the node circle, relative to the node centre. */
export const LABEL_DY = 22;
export const COST_DY = 34;

export function truncateLabel(text: string, max: number = LABEL_MAX_CHARS): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

/** The node's text: a container shows its agent name, marked when the container is stopped. */
export function nodeLabel(d: TreeNode): string {
  return d._agentNode && d.stopped ? `${d.name} (stopped)` : d.name;
}

export interface LayoutBox {
  node: TreeNode;
  depth: number;
  /** Horizontal centre of the node (and of its label). */
  x: number;
  /** Vertical position of the node circle. */
  y: number;
  /** Width of the widest text under the node. */
  width: number;
}

/**
 * Lays the tree out left to right. Every leaf gets its own vertical slot of NODE_BLOCK_HEIGHT, so
 * siblings never overlap whatever their number, and a parent sits at the middle of its children.
 * Every depth gets a column as wide as its widest text plus DEPTH_GAP, so a parent's label never
 * runs into its child's. `textsOf` returns the lines drawn under a node (label, cost).
 * A virtual root takes no room.
 */
export function layoutTree(root: TreeNode, textsOf: (n: TreeNode) => string[]): LayoutBox[] {
  const boxes: LayoutBox[] = [];
  const colWidth: number[] = [];
  let nextSlot = 0;

  const widthOf = (n: TreeNode): number =>
    n._virtualRoot ? 0 : Math.max(16, ...textsOf(n).map((t) => Array.from(t).length * LABEL_CHAR_WIDTH));

  const place = (n: TreeNode, depth: number): LayoutBox => {
    const box: LayoutBox = { node: n, depth, x: 0, y: 0, width: widthOf(n) };
    boxes.push(box);
    colWidth[depth] = Math.max(colWidth[depth] ?? 0, box.width);
    const kids = (n.children ?? []).map((c) => place(c, depth + 1));
    if (kids.length) box.y = (kids[0].y + kids[kids.length - 1].y) / 2;
    else box.y = nextSlot++ * NODE_BLOCK_HEIGHT;
    return box;
  };
  place(root, 0);

  const centres: number[] = [];
  let edge = 0;
  colWidth.forEach((w, depth) => {
    if (depth > 0 && colWidth[depth - 1] > 0) edge += DEPTH_GAP;
    centres[depth] = edge + w / 2;
    edge += w;
  });
  for (const b of boxes) b.x = centres[b.depth];
  return boxes;
}

/**
 * The key that decides when the lineage view refits: the filter and the tree structure only
 * (every node's uid and its parent's). Cost, state and model change on every live update of a
 * running session and must not move the view.
 */
export function topologyFitKey(filter: string, tree: TreeNode): string {
  const parts: string[] = [];
  const walk = (node: TreeNode, parent: string) => {
    parts.push(`${node.uid}<${parent}`);
    for (const child of node.children ?? []) walk(child, node.uid);
  };
  for (const child of tree.children ?? []) walk(child, tree.uid);
  return JSON.stringify({ filter, nodes: parts });
}
