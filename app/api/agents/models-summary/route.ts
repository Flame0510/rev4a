/**
 * GET /api/agents/models-summary
 *
 * One row per agent, running or not: which model it runs, and whether that model is in
 * good standing. Feeds the model chip on the agent cards, so the list answers
 * "what is this agent running, and is it fine?" without opening anything.
 *
 * That question had no cheap answer before: the model lived only inside each
 * container's config, and the only route that read it walked the whole fleet.
 * Three agents silently moved to DeepSeek V4.1, and one has been pointing at a
 * model absent from its own catalogue, precisely because nothing surfaced it.
 *
 * Fan-out uses the NoFail variants: one unreachable container must degrade its
 * own row, not blank the page. `mapWithConcurrency` is fail-fast, so a throwing
 * mapper would discard every result already computed.
 */
import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dockerExecNoFail, mapWithConcurrency } from '@/lib/docker-exec';
import { loadModelsConfig, loadOfferedModels } from '@/lib/model-catalogue';
import { singleFileFromTar } from '@/lib/container-file';
import { requireAuthJWT } from '@/lib/rev4a-auth';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

/** Matches the per-agent query cap used elsewhere for fleet walks. */
const CONCURRENCY = 6;

const CONFIG_PATH = '/root/.openclaw/openclaw.json';

/** A not-running agent's config, through `docker cp`. Empty string when unreadable. */
async function readNotRunningConfig(container: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', ['cp', `${container}:${CONFIG_PATH}`, '-'], {
      encoding: 'buffer', timeout: 8000, maxBuffer: 1024 * 1024,
    });
    return singleFileFromTar(stdout as unknown as Buffer).body.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * - `missing`     the primary is not in the catalogue at all
 * - `disabled`    in the catalogue but not offered: unchecked, or its provider has no key
 * - `out-of-sync` offered by the gateway, absent from this container's synced copy
 * - `deprecated`  works, on a name upstream has retired
 */
export type ModelHealth = 'ok' | 'deprecated' | 'missing' | 'disabled' | 'out-of-sync' | 'unset' | 'unknown';

export interface AgentModelRow {
  agentId: string;
  containerName: string;
  primary: string | null;
  fallbackCount: number;
  /** First fallback, for the one-line hint on the card. The rest stay in the panel. */
  firstFallback: string | null;
  health: ModelHealth;
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as any;

  let agents: { agentId: string; containerName: string; running: boolean }[] = [];
  try {
    // `-a`: a stopped agent is the likeliest to be sitting on a model that has
    // since been removed or disabled, and it needs a chip as much as any.
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '-a', '--filter', 'label=AGENT_ID', '--format', '{{.Label "AGENT_ID"}}\t{{.Names}}\t{{.State}}'],
      { encoding: 'utf8', timeout: 5000 },
    );
    agents = stdout.trim().split('\n')
      .map((line) => {
        const [agentId, containerName, state] = line.split('\t');
        if (!containerName?.trim()) return null;
        return {
          agentId: agentId?.trim() || containerName.trim(),
          containerName: containerName.trim(),
          running: state?.trim() === 'running',
        };
      })
      .filter(Boolean) as { agentId: string; containerName: string; running: boolean }[];
  } catch (e) {
    // Not an empty list: that reads as "every agent is fine".
    return NextResponse.json(
      { agents: [], error: `Docker is unreachable: ${(e as Error).message.split('\n')[0]}` },
      { status: 503 },
    );
  }

  if (agents.length === 0) return NextResponse.json({ agents: [] });

  // Deprecation is a property of the catalogue, not of the container: read it once.
  const catalogue = new Map(loadModelsConfig().map((m) => [m.id, m]));
  // What the gateway will actually serve. The proxy refuses anything outside it,
  // so this set, not the container's copy, decides whether an agent can work.
  const offered = new Set(loadOfferedModels().map((m) => m.id));

  const rows = await mapWithConcurrency(agents, CONCURRENCY, async (agent): Promise<AgentModelRow> => {
    const base: AgentModelRow = {
      agentId: agent.agentId,
      containerName: agent.containerName,
      primary: null,
      fallbackCount: 0,
      firstFallback: null,
      health: 'unknown',
    };

    const raw = agent.running
      ? await dockerExecNoFail(agent.containerName, ['cat', CONFIG_PATH], { timeoutMs: 8000 })
      : await readNotRunningConfig(agent.containerName);
    // An empty body means unreachable *or* a read killed by the deadline —
    // `docker exec` exits 0 either way, so both stay 'unknown' rather than
    // being reported as a healthy agent with no model.
    if (!raw) return base;

    let config: Record<string, unknown>;
    try { config = JSON.parse(raw); } catch { return base; }

    const defaults = ((config.agents ?? {}) as Record<string, unknown>).defaults ?? {};
    const model = (defaults as Record<string, unknown>).model;
    const primary = typeof model === 'string'
      ? model
      : (model && typeof model === 'object' ? (model as Record<string, unknown>).primary : null);
    const fallbacks = model && typeof model === 'object' && Array.isArray((model as Record<string, unknown>).fallbacks)
      ? ((model as Record<string, unknown>).fallbacks as unknown[])
      : [];

    if (typeof primary !== 'string' || !primary) return { ...base, health: 'unset' };

    const bare = primary.replace(/^rev4a\//, '');
    const models = ((config.models ?? {}) as Record<string, unknown>).providers ?? {};
    const rev4a = ((models as Record<string, unknown>).rev4a ?? {}) as Record<string, unknown>;
    const ids = (Array.isArray(rev4a.models) ? rev4a.models : [])
      .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).id : null))
      .filter((id): id is string => typeof id === 'string');

    const entry = catalogue.get(bare);
    let health: ModelHealth;
    // Ordered by remedy. Each case asks something different of the operator, and
    // the single 'missing' this replaced pointed at the wrong fix half the time.
    if (!entry) health = 'missing';                       // gone from the catalogue: pick another model
    else if (!offered.has(bare)) health = 'disabled';     // exists, not offered: the proxy refuses it
    else if (!ids.includes(bare)) health = 'out-of-sync'; // offered, never reached this container: Sync All
    else if (entry.deprecated) health = 'deprecated';     // works, on a retired name
    else health = 'ok';

    return {
      ...base,
      primary,
      fallbackCount: fallbacks.length,
      firstFallback: typeof fallbacks[0] === 'string' ? (fallbacks[0] as string) : null,
      health,
    };
  });

  return NextResponse.json({ agents: rows });
}
