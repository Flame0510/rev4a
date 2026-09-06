import { NextResponse } from 'next/server';
import { getProfile, markSynced, markDesynced } from '@/lib/credentials/vault';
import { syncProfileToAgents, cleanAgentProviders } from '@/lib/credentials/delivery';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    const profile = getProfile(id);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await request.json().catch(() => ({})) as { containers?: string[] };
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
export async function DELETE(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    const profile = getProfile(id);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await request.json().catch(() => ({})) as { container?: string };
    const container = body.container;
    if (!container) {
      return NextResponse.json({ error: 'container is required' }, { status: 400 });
    }

    await cleanAgentProviders(container, profile.providerId);
    markDesynced(id);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
