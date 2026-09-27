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

const TOTALS_SQL = `
  SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(total_tokens), 0) AS tokens,
    COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
    COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(cache_write), 0) AS cacheWrite,
    COALESCE(SUM(input_cost), 0) AS inputCost, COALESCE(SUM(output_cost), 0) AS outputCost,
    COALESCE(SUM(cache_read_cost), 0) AS cacheReadCost, COALESCE(SUM(cache_write_cost), 0) AS cacheWriteCost,
    COALESCE(SUM(missing), 0) AS missing
  FROM agent_cost_daily`;

/**
 * Everything the Costs page shows for a range of UTC dates. `container` narrows it to
 * one agent (the agent panel).
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

  const totals = db.prepare(`${TOTALS_SQL} WHERE ${where}`).get(params) as CostTotals;

  const dailyRows = db.prepare(`
    SELECT date, SUM(cost) AS cost, SUM(total_tokens) AS tokens, SUM(missing) AS missing
    FROM agent_cost_daily WHERE ${where} GROUP BY date`).all(params) as CostSummary['daily'];
  const byDate = new Map(dailyRows.map((r) => [r.date, r]));
  const daily = dates.map((date) => byDate.get(date) ?? { date, cost: 0, tokens: 0, missing: 0 });

  const sources = (db.prepare('SELECT * FROM agent_cost_sources').all() as SourceRow[])
    .filter((s) => !opts.container || s.container === opts.container);
  const spend = new Map(
    (db.prepare(`
      SELECT container, SUM(cost) AS cost, SUM(total_tokens) AS tokens, SUM(missing) AS missing
      FROM agent_cost_daily WHERE ${where} GROUP BY container`).all(params) as
      { container: string; cost: number; tokens: number; missing: number }[]).map((r) => [r.container, r]),
  );
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

  const byModel = db.prepare(`
    SELECT provider, model, SUM(cost) AS cost, SUM(tokens) AS tokens, SUM(calls) AS calls
    FROM agent_cost_model_daily WHERE ${where}
    GROUP BY provider, model HAVING SUM(tokens) > 0 OR SUM(cost) > 0 ORDER BY cost DESC, tokens DESC`).all(params) as ModelCostRow[];

  const names = new Map(sources.map((s) => [s.container, s.name]));
  const since = Date.parse(`${startDate}T00:00:00Z`);
  const sessions = (db.prepare(`
    SELECT container, session_id AS sessionId, session_key AS sessionKey, label, agent_id AS agentId, model,
      cost, tokens, missing, last_activity AS lastActivity
    FROM agent_cost_sessions WHERE last_activity >= @since${opts.container ? ' AND container = @container' : ''}
    ORDER BY cost DESC, tokens DESC LIMIT @limit`).all({ since, container: opts.container ?? null, limit: opts.topSessions ?? 20 }) as
    Omit<SessionCostRow, 'agentName'>[])
    .map((s) => ({ ...s, agentName: names.get(s.container) ?? null }));

  const unpricedMap = new Map<string, { model: string; calls: number; agents: string[] }>();
  for (const s of sources) {
    let parsed: Record<string, number> = {};
    try { parsed = JSON.parse(s.missing_by_model || '{}'); } catch { /* keep empty */ }
    for (const [model, calls] of Object.entries(parsed)) {
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
 * Today's spend (UTC day) and all-time spend, by model today — for the dashboard. Null
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
    const t = db.prepare(`${TOTALS_SQL} WHERE date = ?`).get(today) as CostTotals;
    const all = db.prepare(`${TOTALS_SQL}`).get() as CostTotals;
    const byModelToday = db.prepare(`
      SELECT provider, model, SUM(cost) AS cost, SUM(tokens) AS tokens, SUM(calls) AS calls
      FROM agent_cost_model_daily WHERE date = ? GROUP BY provider, model HAVING SUM(tokens) > 0 OR SUM(cost) > 0 ORDER BY cost DESC, tokens DESC`).all(today) as ModelCostRow[];
    return { today: t.cost, allTime: all.cost, missingToday: t.missing, byModelToday };
  } catch (e) {
    return { today: 0, allTime: 0, missingToday: 0, byModelToday: [], error: (e as Error).message };
  } finally {
    db?.close();
  }
}
