import { type NextRequest } from "next/server";
/**
 * Gateway Status API
 *
 * Reports the per-agent model settings the Gateway page needs to render its
 * agent cards and pre-fill the "edit default model" form. Only containers with
 * an AGENT_ID label are considered — no hardcoded container names.
 *
 * GET /api/gateway
 *
 * This used to shell out to the OpenClaw CLI inside every container, twice:
 * `openclaw models status --json` (~5.7s) and `openclaw models list --json`
 * (~4.4s), serially, with execSync — so ~10s per agent with the event loop
 * frozen throughout, and roughly 70s on a seven-agent host.
 *
 * Both were avoidable. `models list` produced a model catalogue and alias map
 * that no line of the UI ever read: the page takes its model list from
 * /api/gateway/provider, which reads local files. And `models status` returned,
 * for the two fields actually used, exactly what sits in the agent's own
 * openclaw.json — verified field by field against a live agent. So the CLI was
 * being booted for five seconds to read a file that `cat` returns in 260ms.
 *
 * The response shape is unchanged so the page keeps working untouched; the
 * fields that came only from the discarded CLI output are now reported empty
 * rather than computed at great cost and thrown away.
 */
import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { dockerExecNoFail, mapWithConcurrency } from '@/lib/docker-exec';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

/** Agents queried at once. Each is a `docker exec … cat`, cheap but still a process. */
const AGENT_QUERY_CONCURRENCY = 8;

const AGENT_CONFIG_PATH = '/root/.openclaw/openclaw.json';

interface GatewayProvider {
  provider: string;
  kind: string;
  detail: string;
  profiles: number;
  labels: string[];
}

interface GatewayAgentStatus {
  agentId: string;
  containerName: string;
  state: string;
  defaultModel: string;
  fallbacks: string[];
  allowed: string[];
  aliases: Record<string, string>;
  providers: GatewayProvider[];
  error?: string;
}

interface AgentRef {
  agentId: string;
  containerName: string;
  state: string;
}

/**
 * Containers carrying an AGENT_ID label, with the label read straight out of
 * `docker ps` rather than a follow-up `docker inspect` per container.
 */
async function getAgents(): Promise<AgentRef[]> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps', '--filter', 'label=AGENT_ID',
      '--format', '{{.Label "AGENT_ID"}}\t{{.Names}}\t{{.State}}',
    ], { encoding: 'utf-8', timeout: 5000 });

    return stdout.trim().split('\n')
      .map((line) => {
        const [agentId, containerName, state] = line.split('\t');
        if (!containerName?.trim()) return null;
        return {
          agentId: agentId?.trim() || containerName.trim(),
          containerName: containerName.trim(),
          state: state?.trim() || 'unknown',
        };
      })
      .filter(Boolean) as AgentRef[];
  } catch {
    return [];
  }
}

/**
 * Read an agent's model settings out of its openclaw.json.
 *
 * `agents.defaults.model` is the same value `openclaw models status` reports as
 * `defaultModel`/`fallbacks`. The CLI additionally resolves an `imageModel`
 * default when the config sets none, but the base image defines no such default
 * (verified: `imageModel: null`), and agent creation always writes an explicit
 * model — so there is no case where the file and the CLI would disagree.
 */
async function readAgentStatus(agent: AgentRef): Promise<GatewayAgentStatus> {
  const raw = await dockerExecNoFail(
    agent.containerName,
    ['cat', AGENT_CONFIG_PATH],
    { timeoutMs: 8000 },
  );

  const base: GatewayAgentStatus = {
    agentId: agent.agentId,
    containerName: agent.containerName,
    state: agent.state,
    defaultModel: '',
    fallbacks: [],
    allowed: [],
    aliases: {},
    providers: [],
  };

  if (!raw) return { ...base, error: 'config unreadable' };

  try {
    const config = JSON.parse(raw) as Record<string, any>;
    const model = config?.agents?.defaults?.model ?? {};
    return {
      ...base,
      defaultModel: typeof model.primary === 'string' ? model.primary : '',
      fallbacks: Array.isArray(model.fallbacks) ? model.fallbacks.map(String) : [],
    };
  } catch {
    return { ...base, error: 'config unparseable' };
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  try {
    const timestamp = Date.now();

    const refs = await getAgents();
    const agents = await mapWithConcurrency(refs, AGENT_QUERY_CONCURRENCY, readAgentStatus);

    // First agent is the "primary" for core model settings
    const primaryAgent = agents[0] ?? null;

    return NextResponse.json({
      timestamp,
      gateway: 'Rev4a Model Gateway',
      status: 'online',
      // The model catalogue lives in /api/gateway/provider, which reads the
      // bundled config plus user overrides. Recomputing it per agent here cost
      // 4.4s each and was never read.
      models: {
        total: 0,
        available: 0,
        byProvider: [],
        list: [],
      },
      agents: {
        total: agents.length,
        list: agents.map((a) => ({
          agentId: a.agentId,
          containerName: a.containerName,
          state: a.state,
          defaultModel: a.defaultModel,
          fallbacks: a.fallbacks,
          aliases: a.aliases,
          providers: a.providers,
        })),
      },
      aliases: {},
      coreModel: primaryAgent
        ? {
            defaultModel: primaryAgent.defaultModel,
            fallbacks: primaryAgent.fallbacks,
          }
        : null,
      // Provider credential state comes from /api/gateway/provider (`configured`
      // per provider), which reads provider-keys.json directly.
      apiKeys: {
        configured: [],
        all: [],
      },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
