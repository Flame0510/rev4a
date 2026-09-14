/**
 * GET /api/agents/[id]/model
 *
 * The model configuration of one agent: primary, fallbacks, and whether the
 * primary is actually resolvable from the catalogue the agent was given.
 *
 * This replaced `GET /api/gateway`, which reported the same two fields but walked
 * every container to do it — on a seven-agent host, seven `docker exec` calls at
 * ~90ms each, paid to open one agent's detail panel. This reads one container.
 *
 * Writes still go to `PUT /api/gateway/agent`, which already handles the
 * `rev4a/` prefixing and fallback de-duplication.
 */
import { NextResponse } from 'next/server';
import { resolveAgentedContainer, isValidAgentId } from '@/lib/container';
import { dockerExecNoFail } from '@/lib/docker-exec';
import { catalogueStatus } from '@/lib/model-catalogue';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

interface ModelRef {
  primary: string | null;
  fallbacks: string[];
}

function readModelRef(config: Record<string, unknown>): ModelRef {
  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
  const model = defaults.model;

  // `model` accepts either a bare string or { primary, fallbacks }.
  if (typeof model === 'string') return { primary: model, fallbacks: [] };
  if (model && typeof model === 'object') {
    const m = model as Record<string, unknown>;
    return {
      primary: typeof m.primary === 'string' ? m.primary : null,
      fallbacks: Array.isArray(m.fallbacks) ? m.fallbacks.filter((f): f is string => typeof f === 'string') : [],
    };
  }
  return { primary: null, fallbacks: [] };
}

/** Model ids the agent's own catalogue offers, as written by gateway/sync. */
function readCatalogueIds(config: Record<string, unknown>): string[] {
  const models = (config.models ?? {}) as Record<string, unknown>;
  const providers = (models.providers ?? {}) as Record<string, unknown>;
  const rev4a = (providers.rev4a ?? {}) as Record<string, unknown>;
  const list = Array.isArray(rev4a.models) ? rev4a.models : [];
  return list
    .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).id : null))
    .filter((id): id is string => typeof id === 'string');
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;

  const { id } = await params;
  if (!id || !isValidAgentId(id)) {
    return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });
  }

  const container = resolveAgentedContainer(id);
  if (!container) {
    return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });
  }

  const raw = await dockerExecNoFail(container, ['cat', '/root/.openclaw/openclaw.json'], { timeoutMs: 8000 });
  if (!raw) {
    // A stopped container, or a read that timed out. `docker exec` exits 0 on
    // the SIGTERM sent at the deadline, so an empty body is the only signal
    // either way — report unknown rather than inventing an empty config.
    return NextResponse.json({ agentId: id, reachable: false, primary: null, fallbacks: [], resolvable: null });
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Container config is not valid JSON' }, { status: 502 });
  }

  const { primary, fallbacks } = readModelRef(config);
  const catalogue = readCatalogueIds(config);

  // The primary is stored prefixed (`rev4a/<id>`); the catalogue stores bare ids.
  const bare = primary ? primary.replace(/^rev4a\//, '') : null;

  return NextResponse.json({
    agentId: id,
    reachable: true,
    primary,
    fallbacks,
    /**
     * False means the agent is configured for a model its own catalogue does not
     * carry — it will fail on its next turn, and with no fallbacks it fails hard.
     * This happens when a model is disabled in the Gateway while some agent still
     * has it as primary.
     */
    resolvable: bare ? catalogue.includes(bare) : null,
    catalogueSize: catalogue.length,
    /**
     * Why the primary would fail regardless of this container: `offered`,
     * `disabled` (unchecked, or no provider key) or `missing` (no longer in the
     * catalogue). Lets the panel name the right cause instead of guessing it.
     */
    primaryStatus: bare ? catalogueStatus(bare) : null,
  });
}
