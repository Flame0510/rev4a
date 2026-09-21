/**
 * Update one agent to a newer supported OpenClaw version (lib/agent-update.ts).
 *
 *   GET   `{ currentVersion, candidate, update }`: the version the agent runs, the
 *         `{ fromVersion, toVersion }` an update would do (null when none is newer),
 *         and the latest update with its status and live backup progress.
 *   POST  `{ version? }` — start an update, by default to the newest supported version
 *         downloaded. 202 with the new update; the steps continue in the background.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { isValidAgentId } from '@/lib/container';
import { isSupportedVersion } from '@/lib/agent-versions';
import { UpdateRefusedError, agentUpdateView, startAgentUpdate, updateCandidate } from '@/lib/agent-update';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
  try {
    const { currentVersion, candidate } = await updateCandidate(id);
    return NextResponse.json(
      { currentVersion, candidate, update: await agentUpdateView(id) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}

export async function POST(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { version?: unknown } | null;
  if (body?.version !== undefined && body.version !== null && !isSupportedVersion(body.version)) {
    return NextResponse.json({ error: 'version must be an OpenClaw version this Rev4a supports' }, { status: 400 });
  }
  try {
    await startAgentUpdate(id, (body?.version as string | undefined) ?? undefined);
    return NextResponse.json({ update: await agentUpdateView(id) }, { status: 202 });
  } catch (e) {
    const status = e instanceof UpdateRefusedError ? 409 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
