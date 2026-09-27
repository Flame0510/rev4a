import { NextResponse, type NextRequest } from 'next/server';
import { dashboardCosts } from '@/lib/agent-costs';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/costs — the dashboard's cost card and the Lineage cost panel: today's spend
 * (UTC day), all-time spend and today's spend by model, as the agents' own OpenClaw
 * priced it (costs.db, see lib/agent-costs.ts). The Costs page has the full picture.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as NextResponse;

  const costs = dashboardCosts();
  if (costs?.error) return NextResponse.json({ error: `costs.db could not be read: ${costs.error}` }, { status: 500 });
  return NextResponse.json({
    today: costs?.today ?? 0,
    allTime: costs?.allTime ?? 0,
    allTimeSource: 'agents_openclaw',
    missingToday: costs?.missingToday ?? 0,
    // Models that cost something today; the Costs page lists the free and unpriced ones.
    byModel: (costs?.byModelToday ?? []).filter((m) => m.cost > 0).map((m) => ({ model: m.model, cost_usd: m.cost, tokens: m.tokens, calls: m.calls })),
  });
}
