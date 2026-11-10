/**
 * What the agents spent, read from costs.db — the figures each agent's own OpenClaw
 * recorded, copied by daemon.js (see docs/dev/DATABASE.md, Costs Database). Nothing here
 * computes a cost. The spend queries of every reader live here — the Costs page, the
 * dashboard (GET /api/costs, the SSE stream, the system-health cost check) and the
 * agent panel; the vendor readings are in lib/cost-reconciliation.ts.
 *
 * Days are UTC dates, as OpenClaw buckets them.
 */
import type Database from 'better-sqlite3';
import { openCostsDb } from './costs-db';
import { ASSISTANT_AGENT, UNKNOWN_AGENT } from './proxy-usage';

/** How often daemon.js reads the agents; a figure older than 3× this is not current. */
export const COLLECT_INTERVAL_S = 300;

export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The UTC dates of the last `days` days, today included, oldest first. */
export function lastDays(days: number, now = Date.now()): string[] {
  return Array.from({ length: days }, (_, i) => utcDate(now - (days - 1 - i) * 86_400_000));
}

export interface CostTotals {
  cost: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number; missing: number;
}
export interface AgentCostRow {
  container: string; agentId: string | null; name: string | null; cost: number; tokens: number; missing: number;
  collectedAt: number | null; attemptedAt: number | null; error: string | null;
}
/**
 * Rows without tokens or cost are left out: OpenClaw also counts internal entries as
 * models (`gateway-injected`, messages the Gateway adds itself) that cost nothing.
 */
export interface ModelCostRow { provider: string; model: string; cost: number; tokens: number; calls: number }
export interface SessionCostRow {
  container: string; agentName: string | null; sessionId: string; sessionKey: string | null; label: string | null;
  agentId: string | null; model: string | null; cost: number; tokens: number; missing: number; lastActivity: number | null;
  /**
   * The session's current provider is a ChatGPT subscription. Its cost is OpenClaw's total for the
   * whole session, so it can include subscription calls at list price as well as paid proxy calls:
   * the session is kept in the list and labelled, not dropped.
   */
  usesSubscription: number;
}
export interface CostSummary {
  totals: CostTotals;
  daily: { date: string; cost: number; tokens: number; missing: number }[];
  byAgent: AgentCostRow[];
  byModel: ModelCostRow[];
  sessions: SessionCostRow[];
  /** Calls OpenClaw could not price, by model, over each agent's last 30 days. */
  unpriced: { model: string; calls: number; agents: string[] }[];
}

interface SourceRow {
  container: string; agent_id: string | null; name: string | null;
  collected_at: number | null; attempted_at: number | null; error: string | null; missing_by_model: string | null;
}

export const EMPTY_TOTALS: CostTotals = {
  cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, missing: 0,
};

/**
 * Providers whose calls a ChatGPT (Codex) subscription covers: OpenClaw's native ChatGPT route
 * (`openai`) and the legacy `openai-codex`. Rev4a never gives an agent an OpenAI API key, so every
 * `openai` row is taken for a subscription call; an operator who adds their own OpenAI key by hand
 * would see those calls here too. THE one place that rule lives: every figure of "Spent" leaves
 * these calls out, and the Costs page shows them apart (their API value, not a spend).
 */
export const SUBSCRIPTION_PROVIDERS = ['openai', 'openai-codex'] as const;
export const isSubscriptionProvider = (provider: string | null | undefined): boolean =>
  !!provider && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider);

const SUB_LIST_SQL = SUBSCRIPTION_PROVIDERS.map((p) => `'${p}'`).join(', ');

/** What the subscription calls of one container on one day recorded (agent_cost_model_daily). */
interface SubDay { tokens: number; cost: number; unpricedCalls: number }
interface DailyRow {
  container: string; date: string; input: number; output: number; cache_read: number; cache_write: number;
  total_tokens: number; cost: number; input_cost: number; output_cost: number; cache_read_cost: number;
  cache_write_cost: number; missing: number;
}

/**
 * agent_cost_daily rows with the subscription calls taken out. The table has no provider, so the
 * per container/day sums of the subscription rows in agent_cost_model_daily are subtracted (never
 * below 0). The split by kind (input, output, cache) is not kept per provider: it is scaled by the
 * share of tokens (counts) or cost (prices) that remains. `missing` (calls OpenClaw could not price)
 * is kept as it is: OpenClaw counts it in usage entries, the model rows in calls, so taking the
 * subscription share out could hide an unpriced paid model. An unpriced subscription model is
 * therefore also in the "calls without a price" warning (fail safe), and in the subscription section.
 */
function readSpendDaily(db: Database.Database, where: string, params: Record<string, unknown>): DailyRow[] {
  const rows = db.prepare(`SELECT * FROM agent_cost_daily WHERE ${where}`).all(params) as DailyRow[];
  const sub = new Map<string, SubDay>();
  for (const r of db.prepare(`
    SELECT container, date, SUM(tokens) AS tokens, SUM(cost) AS cost,
      SUM(CASE WHEN cost = 0 AND tokens > 0 THEN calls ELSE 0 END) AS unpricedCalls
    FROM agent_cost_model_daily WHERE ${where} AND provider IN (${SUB_LIST_SQL}) GROUP BY container, date`).all(params) as
    (SubDay & { container: string; date: string })[]) {
    sub.set(`${r.container}|${r.date}`, r);
  }
  if (!sub.size) return rows;
  return rows.map((r) => {
    const s = sub.get(`${r.container}|${r.date}`);
    if (!s) return r;
    // A day that was all subscription leaves a float residue (3e-18): snap it to 0, or it reads "$0.0000".
    const diff = r.cost - s.cost;
    const cost = diff > 1e-9 ? diff : 0;
    const tokens = Math.max(0, r.total_tokens - s.tokens);
    const c = r.cost > 0 ? cost / r.cost : 1;
    const t = r.total_tokens > 0 ? tokens / r.total_tokens : 1;
    return {
      ...r, cost, total_tokens: tokens,
      input: Math.round(r.input * t), output: Math.round(r.output * t),
      cache_read: Math.round(r.cache_read * t), cache_write: Math.round(r.cache_write * t),
      input_cost: r.input_cost * c, output_cost: r.output_cost * c,
      cache_read_cost: r.cache_read_cost * c, cache_write_cost: r.cache_write_cost * c,
      missing: r.missing,
    };
  });
}

function sumTotals(rows: DailyRow[]): CostTotals {
  const t = { ...EMPTY_TOTALS };
  for (const r of rows) {
    t.cost += r.cost; t.tokens += r.total_tokens; t.input += r.input; t.output += r.output;
    t.cacheRead += r.cache_read; t.cacheWrite += r.cache_write;
    t.inputCost += r.input_cost; t.outputCost += r.output_cost;
    t.cacheReadCost += r.cache_read_cost; t.cacheWriteCost += r.cache_write_cost; t.missing += r.missing;
  }
  return t;
}

/** The spend model rows of a range: every provider but the subscription's. */
const SPEND_MODELS_SQL = `
  SELECT provider, model, SUM(cost) AS cost, SUM(tokens) AS tokens, SUM(calls) AS calls
  FROM agent_cost_model_daily WHERE %WHERE% AND provider NOT IN (${SUB_LIST_SQL})
  GROUP BY provider, model HAVING SUM(tokens) > 0 OR SUM(cost) > 0 ORDER BY cost DESC, tokens DESC`;

/* ------------------------------------------------------------------ */
/*  ChatGPT subscription usage: not a spend                            */
/* ------------------------------------------------------------------ */

export interface SubscriptionModelRow {
  provider: string; model: string; tokens: number; calls: number;
  /** What the calls would have cost at OpenAI API prices (OpenClaw's catalogue). */
  apiValue: number;
  /** Calls of this model OpenClaw recorded with tokens and no cost: it has no price. */
  unpricedCalls: number;
}
export interface SubscriptionAgentRow {
  container: string; name: string | null; tokens: number; calls: number; apiValue: number; unpricedCalls: number;
}
export interface SubscriptionUsage {
  totals: { tokens: number; calls: number; apiValue: number; unpricedCalls: number };
  byAgent: SubscriptionAgentRow[];
  byModel: SubscriptionModelRow[];
  /** Models with calls and no price, over the range. */
  unpriced: { model: string; calls: number }[];
}

export const EMPTY_SUBSCRIPTION: SubscriptionUsage = {
  totals: { tokens: 0, calls: 0, apiValue: 0, unpricedCalls: 0 }, byAgent: [], byModel: [], unpriced: [],
};

/**
 * What the subscription calls of a range would have cost at API prices — the saving the plan gives.
 * Empty when there are none. `container` narrows it to one agent.
 */
export function readSubscriptionUsage(
  db: Database.Database, dates: string[], opts: { container?: string } = {},
): SubscriptionUsage {
  const where = `date BETWEEN @startDate AND @endDate${opts.container ? ' AND container = @container' : ''}`;
  const params = { startDate: dates[0], endDate: dates[dates.length - 1], container: opts.container ?? null };
  const rows = db.prepare(`
    SELECT container, provider, model, SUM(tokens) AS tokens, SUM(cost) AS cost, SUM(calls) AS calls,
      SUM(CASE WHEN cost = 0 AND tokens > 0 THEN calls ELSE 0 END) AS unpricedCalls
    FROM agent_cost_model_daily WHERE ${where} AND provider IN (${SUB_LIST_SQL})
    GROUP BY container, provider, model HAVING SUM(tokens) > 0 OR SUM(cost) > 0 OR SUM(calls) > 0`).all(params) as
    { container: string; provider: string; model: string; tokens: number; cost: number; calls: number; unpricedCalls: number }[];
  if (!rows.length) return EMPTY_SUBSCRIPTION;

  const names = new Map((db.prepare('SELECT container, name FROM agent_cost_sources').all() as
    { container: string; name: string | null }[]).map((r) => [r.container, r.name]));
  const agents = new Map<string, SubscriptionAgentRow>();
  const models = new Map<string, SubscriptionModelRow>();
  const totals = { tokens: 0, calls: 0, apiValue: 0, unpricedCalls: 0 };
  for (const r of rows) {
    totals.tokens += r.tokens; totals.calls += r.calls; totals.apiValue += r.cost; totals.unpricedCalls += r.unpricedCalls;
    const a = agents.get(r.container) ?? { container: r.container, name: names.get(r.container) ?? null, tokens: 0, calls: 0, apiValue: 0, unpricedCalls: 0 };
    a.tokens += r.tokens; a.calls += r.calls; a.apiValue += r.cost; a.unpricedCalls += r.unpricedCalls;
    agents.set(r.container, a);
    // One model reached through both subscription providers is one line.
    const m = models.get(r.model) ?? { provider: r.provider, model: r.model, tokens: 0, calls: 0, apiValue: 0, unpricedCalls: 0 };
    m.tokens += r.tokens; m.calls += r.calls; m.apiValue += r.cost; m.unpricedCalls += r.unpricedCalls;
    models.set(r.model, m);
  }
  const byValue = <T extends { apiValue: number; tokens: number }>(a: T, b: T) => b.apiValue - a.apiValue || b.tokens - a.tokens;
  const byModel = [...models.values()].sort(byValue);
  return {
    totals,
    byAgent: [...agents.values()].sort(byValue),
    byModel,
    unpriced: byModel.filter((m) => m.unpricedCalls > 0).map((m) => ({ model: m.model, calls: m.unpricedCalls })),
  };
}

/**
 * Everything the Costs page shows for a range of UTC dates. `container` narrows it to
 * one agent (the agent panel). Subscription calls are not in it (see SUBSCRIPTION_PROVIDERS).
 */
export function readCostSummary(
  db: Database.Database,
  dates: string[],
  opts: { container?: string; topSessions?: number } = {},
): CostSummary {
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const where = `date BETWEEN @startDate AND @endDate${opts.container ? ' AND container = @container' : ''}`;
  const params = { startDate, endDate, container: opts.container ?? null };
  const now = Date.now();

  const rows = readSpendDaily(db, where, params);
  const totals = sumTotals(rows);

  const byDate = new Map<string, CostSummary['daily'][number]>();
  for (const r of rows) {
    const d = byDate.get(r.date) ?? { date: r.date, cost: 0, tokens: 0, missing: 0 };
    d.cost += r.cost; d.tokens += r.total_tokens; d.missing += r.missing;
    byDate.set(r.date, d);
  }
  const daily = dates.map((date) => byDate.get(date) ?? { date, cost: 0, tokens: 0, missing: 0 });

  const sources = (db.prepare('SELECT * FROM agent_cost_sources').all() as SourceRow[])
    .filter((s) => !opts.container || s.container === opts.container);
  const spend = new Map<string, { cost: number; tokens: number; missing: number }>();
  for (const r of rows) {
    const e = spend.get(r.container) ?? { cost: 0, tokens: 0, missing: 0 };
    e.cost += r.cost; e.tokens += r.total_tokens; e.missing += r.missing;
    spend.set(r.container, e);
  }
  const byAgent = sources
    .map((s) => ({
      container: s.container,
      agentId: s.agent_id,
      name: s.name,
      cost: spend.get(s.container)?.cost ?? 0,
      tokens: spend.get(s.container)?.tokens ?? 0,
      missing: spend.get(s.container)?.missing ?? 0,
      collectedAt: s.collected_at,
      attemptedAt: s.attempted_at,
      error: s.error,
    }))
    .filter((a) => a.tokens > 0 || a.missing > 0 || a.error || (a.attemptedAt ?? 0) > now - 3 * COLLECT_INTERVAL_S * 1000)
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  const byModel = db.prepare(SPEND_MODELS_SQL.replace('%WHERE%', where)).all(params) as ModelCostRow[];

  const names = new Map(sources.map((s) => [s.container, s.name]));
  const since = Date.parse(`${startDate}T00:00:00Z`);
  const sessions = (db.prepare(`
    SELECT container, session_id AS sessionId, session_key AS sessionKey, label, agent_id AS agentId, model,
      cost, tokens, missing, last_activity AS lastActivity,
      CASE WHEN COALESCE(provider, '') IN (${SUB_LIST_SQL}) THEN 1 ELSE 0 END AS usesSubscription
    FROM agent_cost_sessions WHERE last_activity >= @since${opts.container ? ' AND container = @container' : ''}
    ORDER BY cost DESC, tokens DESC LIMIT @limit`).all({ since, container: opts.container ?? null, limit: opts.topSessions ?? 20 }) as
    Omit<SessionCostRow, 'agentName'>[])
    .map((s) => ({ ...s, agentName: names.get(s.container) ?? null }));

  const unpricedMap = new Map<string, { model: string; calls: number; agents: string[] }>();
  for (const s of sources) {
    let parsed: Record<string, number> = {};
    try { parsed = JSON.parse(s.missing_by_model || '{}'); } catch { /* keep empty */ }
    for (const [model, calls] of Object.entries(parsed)) {
      // OpenClaw names an unpriced model `provider/model`; the subscription's are reported apart.
      if (!calls) continue;
      const entry = unpricedMap.get(model) ?? { model, calls: 0, agents: [] };
      entry.calls += calls;
      entry.agents.push(s.name ?? s.container);
      unpricedMap.set(model, entry);
    }
  }
  const unpriced = [...unpricedMap.values()].sort((a, b) => b.calls - a.calls);

  return { totals, daily, byAgent, byModel, sessions, unpriced };
}

/**
 * Today's spend (UTC day) and all-time spend, by model today — for the dashboard (subscription
 * calls left out, like everywhere). Null
 * when there is nothing to read yet; never throws, so a broken costs.db cannot fail a
 * page about something else (the reason is in `error`).
 */
export function dashboardCosts(): {
  today: number; allTime: number; missingToday: number;
  byModelToday: ModelCostRow[]; error?: string;
} | null {
  let db: Database.Database | null = null;
  try {
    db = openCostsDb();
    if (!db) return null;
    const today = utcDate(Date.now());
    const t = sumTotals(readSpendDaily(db, 'date = @today', { today }));
    const all = sumTotals(readSpendDaily(db, '1 = 1', {}));
    const byModelToday = db.prepare(SPEND_MODELS_SQL.replace('%WHERE%', 'date = @today')).all({ today }) as ModelCostRow[];
    return { today: t.cost, allTime: all.cost, missingToday: t.missing, byModelToday };
  } catch (e) {
    return { today: 0, allTime: 0, missingToday: 0, byModelToday: [], error: (e as Error).message };
  } finally {
    db?.close();
  }
}

/* ------------------------------------------------------------------ */
/*  What the proxy metered, next to what the agents recorded           */
/* ------------------------------------------------------------------ */

/**
 * What the Rev4a provider proxy saw from one caller (proxy_usage_hourly, written by the
 * proxy itself — lib/proxy-usage.js). `agent` is the AGENT_ID named by the agent's own proxy
 * token (or, for a caller still on the shared key, its `x-rev4a-agent` header), `assistant` for
 * PULSE, `unknown` otherwise: a token whose id is not a known agent, or a shared-key call with no
 * usable header (a shared-key header may name an agent not seen yet, within the resolver's bound).
 */
export interface ProxyAgentRow {
  agent: string; calls: number; promptTokens: number; completionTokens: number; cachedTokens: number;
  errors: number; noUsage: number; cost: number;
}

/**
 * One line of the "metered at the proxy / recorded by the agent" comparison. `recorded`
 * is OpenClaw's figure (agent_cost_daily), `metered` the proxy's; either can be absent
 * (an agent on another provider never reaches the proxy; `unknown` is not an agent).
 */
export interface AgentMetering {
  key: string;
  container: string | null; agentId: string | null; name: string | null;
  recorded: number; recordedTokens: number;
  metered: ProxyAgentRow | null;
  /** The larger of the two: the spend the page counts. 0 for `unknown`, which is never added. */
  combined: number;
  /** metered − recorded, when positive; 0 otherwise. */
  gap: number;
  /** The proxy saw clearly more than the agent recorded. */
  flagged: boolean;
}

/** More than this share above the recorded figure, and more than FLAG_MIN_USD in dollars. */
export const FLAG_RATIO = 1.2;
export const FLAG_MIN_USD = 0.1;

export interface ProxyUsageSummary {
  /** False when costs.db has no proxy table yet (nothing has gone through the proxy since the update). */
  available: boolean;
  byAgent: AgentMetering[];
  recordedCost: number;
  meteredCost: number;
  /** Σ over callers of the larger figure. */
  combinedCost: number;
}

export const EMPTY_PROXY_USAGE: ProxyUsageSummary = { available: false, byAgent: [], recordedCost: 0, meteredCost: 0, combinedCost: 0 };

/** Agents in agent_cost_sources that `shown` does not list, with zero figures (for buildProxyUsage). */
export function readIdleAgents(db: Database.Database, shown: AgentCostRow[]): AgentCostRow[] {
  const listed = new Set(shown.map((a) => a.container));
  const rows = db.prepare('SELECT container, agent_id AS agentId, name FROM agent_cost_sources').all() as
    { container: string; agentId: string | null; name: string | null }[];
  return rows.filter((r) => !listed.has(r.container)).map((r) => ({
    container: r.container, agentId: r.agentId, name: r.name, cost: 0, tokens: 0, missing: 0,
    collectedAt: null, attemptedAt: null, error: null,
  }));
}

/** The proxy's figures per caller for [startMs, endMs). Null when the table does not exist yet. */
export function readProxyUsage(db: Database.Database, startMs: number, endMs: number): ProxyAgentRow[] | null {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proxy_usage_hourly'`).get();
  if (!has) return null;
  return db.prepare(`
    SELECT agent, SUM(calls) AS calls, SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens,
      SUM(cached_tokens) AS cachedTokens, SUM(errors) AS errors, SUM(no_usage) AS noUsage, SUM(cost) AS cost
    FROM proxy_usage_hourly WHERE hour >= @from AND hour < @to GROUP BY agent`)
    .all({ from: Math.floor(startMs / 1000), to: Math.floor(endMs / 1000) }) as ProxyAgentRow[];
}

function mergeProxyRows(rows: ProxyAgentRow[], agent: string): ProxyAgentRow {
  const sum = (k: Exclude<keyof ProxyAgentRow, 'agent'>) => rows.reduce((n, r) => n + r[k], 0);
  return {
    agent, calls: sum('calls'), promptTokens: sum('promptTokens'), completionTokens: sum('completionTokens'),
    cachedTokens: sum('cachedTokens'), errors: sum('errors'), noUsage: sum('noUsage'), cost: sum('cost'),
  };
}

/**
 * Pair each agent's recorded figure with the proxy's. The proxy keys on AGENT_ID, which
 * agent_cost_sources keeps as `agent_id` (the container name matches it when it is not set).
 * Proxy callers no agent row claims are listed on their own.
 */
export function buildProxyUsage(
  byAgent: AgentCostRow[], proxy: ProxyAgentRow[] | null, idle: AgentCostRow[] = [],
): ProxyUsageSummary {
  if (!proxy) return EMPTY_PROXY_USAGE;
  // One row per caller: readProxyUsage groups by agent, but sum here too rather than keep the last.
  const unclaimed = new Map<string, ProxyAgentRow>();
  for (const p of proxy) {
    const prev = unclaimed.get(p.agent);
    unclaimed.set(p.agent, prev ? mergeProxyRows([prev, p], p.agent) : p);
  }
  const lines: AgentMetering[] = [];
  // 'unknown' and 'assistant' have no recorded figure to compare with: never flagged.
  const RESERVED = new Set([UNKNOWN_AGENT, ASSISTANT_AGENT]);
  const line = (
    key: string, row: AgentCostRow | null, metered: ProxyAgentRow | null,
  ): AgentMetering => {
    const recorded = row?.cost ?? 0;
    const meteredCost = metered?.cost ?? 0;
    return {
      key, container: row?.container ?? null, agentId: row?.agentId ?? null, name: row?.name ?? null,
      recorded, recordedTokens: row?.tokens ?? 0, metered,
      // Calls without the header may be an agent's own spend that the agent already recorded
      // (an agent not yet synced): adding them would count it twice. They keep their figures
      // but add nothing to Spent. The assistant is recorded nowhere else, so it is added.
      combined: !row && metered?.agent === UNKNOWN_AGENT ? 0 : Math.max(recorded, meteredCost),
      gap: Math.max(0, meteredCost - recorded),
      flagged: !!row && !RESERVED.has(metered?.agent ?? '') && meteredCost > recorded * FLAG_RATIO && meteredCost - recorded > FLAG_MIN_USD,
    };
  };
  // `idle`: agents the summary left out (stopped, nothing recorded in the range). The proxy may
  // still have seen them, which is the case worth showing: named, and compared with their 0.
  for (const a of [...byAgent, ...idle]) {
    // One agent can have rows under both its agentId and its container name: merge them.
    const aliases = [...new Set([a.agentId, a.container].filter((k): k is string => !!k && unclaimed.has(k)))];
    const metered = aliases.length ? mergeProxyRows(aliases.map((k) => unclaimed.get(k)!), aliases[0]) : null;
    for (const k of aliases) unclaimed.delete(k);
    if (a.cost > 0 || a.tokens > 0 || metered) lines.push(line(a.container, a, metered));
  }
  for (const p of unclaimed.values()) lines.push(line(`proxy:${p.agent}`, null, p));
  lines.sort((a, b) => b.combined - a.combined || a.key.localeCompare(b.key));
  return {
    available: true,
    byAgent: lines,
    recordedCost: lines.reduce((n, l) => n + l.recorded, 0),
    meteredCost: lines.reduce((n, l) => n + (l.metered?.cost ?? 0), 0),
    combinedCost: lines.reduce((n, l) => n + l.combined, 0),
  };
}
