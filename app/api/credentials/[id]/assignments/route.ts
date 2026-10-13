import { NextResponse } from 'next/server';
import { getProfile } from '@/lib/credentials/vault';
import { listAssignments, deleteAssignment, parseMode, type CredentialAssignment } from '@/lib/credentials/assignments';
import { enableAssignment, disableAssignment, agentWriteRefusal, type SyncResult } from '@/lib/credentials/delivery';
import { nativeProvider } from '@/lib/credentials/native';
import { agentUsesCodex } from '@/lib/credentials/runtime';
import { listAgentContainers } from '@/lib/subscriptions';
import { mapWithConcurrency } from '@/lib/docker-exec';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { requiresContainerWrite } from '@/lib/credentials/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CONCURRENCY = 4;

interface AgentRow {
  container: string;
  agentId: string;
  displayName: string | null;
  running: boolean;
  /** The agent's default model runs on the ChatGPT (Codex) runtime. */
  codex: boolean;
  assignment: CredentialAssignment | null;
}

async function buildRows(profileId: string): Promise<AgentRow[]> {
  const agents = await listAgentContainers();
  const assignments = listAssignments(profileId);
  const byAgent = new Map(assignments.map((a) => [a.agentId, a]));
  const rows = await mapWithConcurrency(agents, 6, async (a): Promise<AgentRow> => ({
    container: a.container,
    agentId: a.agentId,
    displayName: a.displayName,
    running: a.running,
    codex: a.running ? await agentUsesCodex(a.container) : false,
    assignment: byAgent.get(a.container) ?? null,
  }));
  // Assignments whose container is gone stay visible, so they can be switched off.
  for (const a of assignments) {
    if (!agents.some((x) => x.container === a.agentId)) {
      rows.push({ container: a.agentId, agentId: a.agentId, displayName: null, running: false, codex: false, assignment: a });
    }
  }
  return rows;
}

/**
 * GET /api/credentials/[id]/assignments
 * Every agent with this credential's assignment (or null), plus the Codex flag.
 */
export async function GET(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    const profile = getProfile(id);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ native: !!nativeProvider(profile.providerId), agents: await buildRows(id) });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

interface PutItem { agent?: unknown; enabled?: unknown; mode?: unknown; forget?: unknown; held?: unknown; intentOnly?: unknown }

/**
 * PUT /api/credentials/[id]/assignments
 * Body: { agent, enabled, mode? } or { assignments: [{ agent, enabled, mode? }] }.
 * Enabling writes the secret store entries and the skill config on that agent;
 * disabling removes them (and anything an earlier release wrote). Per-agent failures
 * come back in `results` and in the assignment's `lastError`; the call itself is 200, also when
 * only the final read of the agent rows fails (`refreshFailed: true`, no `agents`; the caller re-reads).
 * 409 (nothing written) for a container write when an agent is stopped or busy.
 * `held: true` on a switch-off says the page saw this credential in the container: the removal runs
 * even when Rev4a has no enabled row for it (the container, not the table, is the source of truth).
 * `intentOnly: true` (with `enabled: false`) clears only Rev4a's setting and runs nothing in the container:
 * the page sends it when the agent holds ANOTHER credential of the same provider, which a provider-wide
 * removal would delete.
 * `{ agent, forget: true }` drops the row of an agent that no longer exists (409 otherwise).
 */
export async function PUT(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    const profile = getProfile(id);
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await request.json().catch(() => ({})) as PutItem & { assignments?: PutItem[] };
    const items: PutItem[] = Array.isArray(body.assignments) ? body.assignments : [body];
    if (items.length === 0 || items.length > 100) {
      return NextResponse.json({ error: 'assignments must hold 1 to 100 items' }, { status: 400 });
    }

    const known = new Set((await listAgentContainers({ fresh: true })).map((a) => a.container));
    const parsed: { agent: string; enabled: boolean; mode: 'env' | 'protected'; forget: boolean; held: boolean; intentOnly: boolean }[] = [];
    for (const it of items) {
      const forget = it.forget === true;
      if (typeof it.agent !== 'string' || !it.agent || (!forget && typeof it.enabled !== 'boolean')) {
        return NextResponse.json({ error: 'agent (string) and enabled (boolean) are required' }, { status: 400 });
      }
      const mode = it.mode === undefined ? 'env' : parseMode(it.mode);
      if (!mode) return NextResponse.json({ error: 'mode must be "env" or "protected"' }, { status: 400 });
      if (forget && known.has(it.agent)) {
        return NextResponse.json({ error: `Agent "${it.agent}" still exists; switch it off instead` }, { status: 409 });
      }
      if (!forget && it.enabled && !known.has(it.agent)) {
        return NextResponse.json({ error: `Agent "${it.agent}" not found` }, { status: 404 });
      }
      if ((it.held !== undefined && typeof it.held !== 'boolean') || (it.intentOnly !== undefined && typeof it.intentOnly !== 'boolean')) {
        return NextResponse.json({ error: '"held" and "intentOnly" must be booleans' }, { status: 400 });
      }
      parsed.push({ agent: it.agent, enabled: it.enabled === true, mode, forget, held: it.held === true, intentOnly: it.intentOnly === true && it.enabled === false });
    }

    // Intent-only and forget operations run nothing in the container.
    for (const p of parsed) {
      if (!requiresContainerWrite(p)) continue;
      const refusal = await agentWriteRefusal(p.agent);
      if (refusal) return NextResponse.json({ error: `${p.agent}: ${refusal}` }, { status: 409 });
    }

    const results: SyncResult[] = await mapWithConcurrency(parsed, CONCURRENCY, async (p) => {
      if (p.forget) {
        deleteAssignment(id, p.agent);
        return { container: p.agent, status: 'ok' as const };
      }
      return p.enabled ? enableAssignment(id, p.agent, p.mode) : disableAssignment(id, p.agent, { held: p.held, intentOnly: p.intentOnly });
    });
    // The changes are done and recorded. Only the read that builds the answer can fail now, and
    // that must not turn a committed switch into a 500: answer with the results and let the
    // page re-read.
    try {
      return NextResponse.json({ results, agents: await buildRows(id) });
    } catch (e: unknown) {
      console.warn('[credentials] assignments saved, but the refreshed rows could not be built:', (e as Error).message);
      return NextResponse.json({ results, refreshFailed: true });
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
