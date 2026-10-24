import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { deleteOrphanVolume } from '@/lib/agent-volumes-server';
import { UNFINISHED_KEPT_REASON } from '@/lib/agent-volumes';

export const dynamic = 'force-dynamic';

/** Remove one orphan agent volume, after checking again that no container uses it and its agent is idle. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const { name } = await params;
  try {
    const result = await deleteOrphanVolume(name);
    if (result === 'invalid') return NextResponse.json({ error: 'Not an agent volume name' }, { status: 400 });
    if (result === 'in_use') return NextResponse.json({ error: 'A container still uses this volume' }, { status: 409 });
    if (result === 'busy') return NextResponse.json({ error: 'This agent is being recreated, updated or edited right now; try again when it finishes' }, { status: 409 });
    if (result === 'kept') return NextResponse.json({ error: UNFINISHED_KEPT_REASON }, { status: 409 });
    if (result === 'not_found') return NextResponse.json({ error: 'Volume not found' }, { status: 404 });
    console.log(`[orphan-volumes] removed ${name}`);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Could not remove the volume' }, { status: 500 });
  }
}
