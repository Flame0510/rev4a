import { NextResponse } from 'next/server';
import { getProfile, markSynced } from '@/lib/credentials/vault';
import { syncProfileToAgents, cleanAgentProviders } from '@/lib/credentials/delivery';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const profile = getProfile(id);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await req.json().catch(() => ({})) as { containers?: string[] };
    const selectedContainers = body.containers;

    const results = await syncProfileToAgents(id, profile.providerId, selectedContainers);

    const anyError = results.some((r) => r.status === 'error');
    markSynced(id, anyError ? 'error' : 'active');

    return NextResponse.json({ results });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * DELETE /api/credentials/[id]/sync
 * De-sync a credential from a single container (removes it without touching others).
 * Body: { container: "prometheus" }
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const profile = getProfile(id);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await req.json().catch(() => ({})) as { container?: string };
    const container = body.container;
    if (!container) {
      return NextResponse.json({ error: 'container is required' }, { status: 400 });
    }

    cleanAgentProviders(container, profile.providerId);
    markSynced(id, 'active');

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
