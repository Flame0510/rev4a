import { NextResponse, type NextRequest } from 'next/server';
import { openCostsDb } from '@/lib/costs-db';
import { COLLECT_INTERVAL_S, lastDays, readCostSummary } from '@/lib/agent-costs';
import { loadOfferedModels } from '@/lib/model-catalogue';
import { nextPriceChange, priceBandAt, priceScheduleFor } from '@/lib/model-pricing';
import { CONTAINER_NAME_RE } from '@/lib/docker-stats';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/** The band DeepSeek bills at right now, when one of its models is on offer — the same object the Costs page header shows. Never throws: the panel's poll must not 500 over a broken key or catalogue file. */
function currentPricing() {
  try {
    const scheduled = loadOfferedModels().map((m) => m.id).filter((id) => priceScheduleFor(id));
    if (!scheduled.length) return null;
    const pricingAt = new Date();
    const next = nextPriceChange(scheduled, pricingAt);
    return { vendor: 'DeepSeek', band: priceBandAt(scheduled[0], pricingAt), nextChange: next ? next.getTime() : null, source: priceScheduleFor(scheduled[0])!.source };
  } catch {
    return null;
  }
}

/**
 * GET /api/costs/agent?container=<name> — one agent's spend for its panel: today, the
 * last 7 and 30 UTC days, its top model and unpriced calls over 30 days, and when it
 * was last read. From costs.db, like the Costs page.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as NextResponse;

  const container = request.nextUrl.searchParams.get('container') ?? '';
  if (!CONTAINER_NAME_RE.test(container)) return NextResponse.json({ error: 'Invalid container name' }, { status: 400 });

  const pricing = currentPricing();

  let db;
  try {
    db = openCostsDb();
  } catch (e) {
    return NextResponse.json({ error: `costs.db could not be read: ${(e as Error).message}` }, { status: 500 });
  }
  if (!db) return NextResponse.json({ available: false, intervalS: COLLECT_INTERVAL_S, pricing });

  try {
    const dates = lastDays(30);
    const s = readCostSummary(db, dates, { container, topSessions: 0 });
    const sum = (n: number) => s.daily.slice(-n).reduce((acc, d) => acc + d.cost, 0);
    // Straight from the sources table: an agent with no use in 30 days is still read.
    const source = db.prepare('SELECT collected_at AS collectedAt, error FROM agent_cost_sources WHERE container = ?')
      .get(container) as { collectedAt: number | null; error: string | null } | undefined;
    const top = s.byModel[0] ?? null;
    const unpriced = s.unpriced.reduce((acc, u) => acc + u.calls, 0);
    return NextResponse.json({
      available: true,
      intervalS: COLLECT_INTERVAL_S,
      pricing,
      today: sum(1),
      week: sum(7),
      month: s.totals.cost,
      tokensMonth: s.totals.tokens,
      topModel: top && top.cost > 0 ? { model: top.model, cost: top.cost } : null,
      unpricedMonth: unpriced,
      collectedAt: source?.collectedAt ?? null,
      error: source?.error ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    db.close();
  }
}
