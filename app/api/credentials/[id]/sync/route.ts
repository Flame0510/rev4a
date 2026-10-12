import { NextResponse } from 'next/server';
import { getProfile } from '@/lib/credentials/vault';
import { syncProfileToAgents, disableAssignment } from '@/lib/credentials/delivery';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/credentials/[id]/sync
 * Kept for older clients: enables the credential on the given containers (all when none).
 * Body: { containers?: string[] }
 */
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

    return NextResponse.json({ results });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * DELETE /api/credentials/[id]/sync
 * De-sync a credential from a single container (switches its assignment off and removes
 * anything an earlier release wrote; other containers are untouched).
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

    const result = await disableAssignment(id, container);
    if (result.status === 'error') {
      return NextResponse.json({ error: result.error ?? 'Removal failed' }, { status: 502 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
