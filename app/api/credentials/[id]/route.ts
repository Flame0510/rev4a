import { NextResponse } from 'next/server';
import { getProfile, updateProfile, deleteProfile } from '@/lib/credentials/vault';
import { listAssignments, deleteAssignments } from '@/lib/credentials/assignments';
import { enableAssignment } from '@/lib/credentials/delivery';
import { mapWithConcurrency } from '@/lib/docker-exec';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';
// PATCH re-delivers a rotated secret to every agent that holds it, two at a time; each delivery
// can take tens of seconds (the OpenClaw CLI boots a process per call).
export const maxDuration = 300;

/** Agents written to at once when a rotated secret is re-delivered. */
const REDELIVERY_CONCURRENCY = 2;

export async function GET(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    const profile = getProfile(id);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(profile);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    const body = await request.json() as { label?: string; secret?: Record<string, string> };
    const { label, secret } = body;

    if (!label) {
      return NextResponse.json({ error: 'label is required' }, { status: 400 });
    }

    updateProfile(id, label, secret ?? {});

    // A changed secret must reach the agents that hold it: rotate the enabled assignments.
    const rotated = Object.values(secret ?? {}).some((v) => typeof v === 'string' && v.trim());
    if (rotated) {
      const results = await mapWithConcurrency(
        listAssignments(id).filter((x) => x.enabled),
        REDELIVERY_CONCURRENCY,
        async (a) => ({ agentId: a.agentId, result: await enableAssignment(id, a.agentId, a.mode, { onlyIfEnabled: true }) }),
      );
      const failed = results.filter((r) => r.result.status === 'error').map((r) => r.agentId);
      if (failed.length) return NextResponse.json({ ok: true, redeliveryFailed: failed });
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    // Switch it off on the agents first: deleting the vault record would leave the
    // token in their secret store with nothing in Rev4a accounting for it.
    const live = listAssignments(id).filter((a) => a.enabled || a.pendingRemoval);
    if (live.length > 0) {
      return NextResponse.json(
        { error: `Switch this credential off on ${live.length} agent(s) (or finish a failed removal) before deleting it` },
        { status: 409 },
      );
    }
    deleteAssignments(id);
    deleteProfile(id);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
