import { NextResponse, type NextRequest } from 'next/server';
import { openCostsDb } from '@/lib/costs-db';
import {
  COLLECT_INTERVAL_S, EMPTY_PROXY_USAGE, EMPTY_SUBSCRIPTION, EMPTY_TOTALS, buildProxyUsage, lastDays, readIdleAgents, readCostSummary,
  readProxyUsage, readSubscriptionUsage,
} from '@/lib/agent-costs';
import { readReconciliation } from '@/lib/cost-reconciliation';
import { loadOfferedModels } from '@/lib/model-catalogue';
import { nextPriceChange, priceBandAt, priceScheduleFor } from '@/lib/model-pricing';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/** Ranges in UTC days, today included. */
const RANGES = { today: 1, '7d': 7, '30d': 30 } as const;
type Range = keyof typeof RANGES;

/**
 * GET /api/costs/usage?range=today|7d|30d — what the agents spent, as each agent's own
 * OpenClaw priced it (collected by daemon.js into costs.db), and how that compares with
 * what the vendors billed. `proxy` adds what the Rev4a provider proxy metered for the same days, per caller,
 * next to each agent's own figure. Nothing here computes a cost. Calls made with a ChatGPT subscription are not
 * in any of those figures: `subscription` holds them apart (tokens, calls and their API value).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as NextResponse;

  const param = request.nextUrl.searchParams.get('range') ?? '7d';
  if (!Object.hasOwn(RANGES, param)) {
    return NextResponse.json({ error: `range must be one of ${Object.keys(RANGES).join(', ')}` }, { status: 400 });
  }
  const range = param as Range;
  const dates = lastDays(RANGES[range]);
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  // The band DeepSeek bills at right now, when a DeepSeek model is on offer.
  const scheduled = loadOfferedModels().map((m) => m.id).filter((id) => priceScheduleFor(id));
  const next = scheduled.length ? nextPriceChange(scheduled) : null;
  const pricing = scheduled.length
    ? { vendor: 'DeepSeek', band: priceBandAt(scheduled[0]), nextChange: next ? next.getTime() : null, source: priceScheduleFor(scheduled[0])!.source }
    : null;

  let db;
  try {
    db = openCostsDb();
  } catch (e) {
    return NextResponse.json({ error: `costs.db could not be read: ${(e as Error).message}` }, { status: 500 });
  }
  if (!db) {
    return NextResponse.json({
      available: false, range, startDate, endDate, intervalS: COLLECT_INTERVAL_S, pricing,
      totals: EMPTY_TOTALS, daily: dates.map((date) => ({ date, cost: 0, tokens: 0, missing: 0 })),
      byAgent: [], byModel: [], sessions: [], unpriced: [], reconciliation: [], proxy: EMPTY_PROXY_USAGE, subscription: EMPTY_SUBSCRIPTION,
    });
  }

  try {
    const summary = readCostSummary(db, dates);
    const subscription = readSubscriptionUsage(db, dates);
    const reconciliation = readReconciliation(db, startDate, endDate);
    // What the proxy metered over the same UTC days, next to each agent's own figure. The proxy
    // table is optional (an install that has not routed a call since the update has none), so a
    // failure here costs the comparison and nothing else.
    let proxy = EMPTY_PROXY_USAGE;
    try {
      const metered = readProxyUsage(db, Date.parse(`${startDate}T00:00:00Z`), Date.parse(`${endDate}T00:00:00Z`) + 86_400_000);
      proxy = buildProxyUsage(summary.byAgent, metered, metered ? readIdleAgents(db, summary.byAgent) : []);
    } catch { /* keep the agents' figures */ }
    return NextResponse.json({
      available: true, range, startDate, endDate, intervalS: COLLECT_INTERVAL_S, pricing, ...summary, reconciliation, proxy, subscription,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    db.close();
  }
}
