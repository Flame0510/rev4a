/**
 * Gateway Status API
 *
 * Aggregates live model/provider state from Olympus agent containers.
 * Only queries containers with AGENT_ID label — no hardcoded container names.
 *
 * GET /api/gateway
 */
import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';

interface GatewayModel {
  key: string;
  provider: string;
  model: string;
  available: boolean;
}

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

interface ApiKeyStatus {
  provider: string;
  configured: boolean;
}

/** Run a command inside a Docker container */
function dockerExec(container: string, cmd: string, timeout = 15000): string {
  try {
    return execSync(
      `docker exec ${container} sh -c ${JSON.stringify(cmd)}`,
      { timeout, maxBuffer: 1024 * 1024, encoding: 'utf-8' },
    );
  } catch {
    return '';
  }
}

/** Get Docker containers with AGENT_ID label — only Olympus-managed agents */
function getAgents(): { agentId: string; containerName: string; state: string }[] {
  try {
    const raw = execSync(
      `docker ps --filter "label=AGENT_ID" --format '{{.Label "AGENT_ID"}}|{{.Names}}|{{.State}}'`,
      { timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf-8' },
    ).trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => {
      const [agentId, containerName, state] = line.split('|');
      return { agentId, containerName, state };
    });
  } catch {
    return [];
  }
}

/** Query an agent container for model status */
function getAgentStatus(agent: { agentId: string; containerName: string; state: string }): GatewayAgentStatus | null {
  const raw = dockerExec(agent.containerName, 'openclaw models status --json', 20000);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const authProviders: Record<string, unknown>[] = data.auth?.providers ?? [];
    const providers: GatewayProvider[] = authProviders.map((p: Record<string, unknown>) => ({
      provider: String(p.provider ?? ''),
      kind: String((p.effective as Record<string, unknown>)?.kind ?? ''),
      detail: String((p.effective as Record<string, unknown>)?.detail ?? ''),
      profiles: Number((p.profiles as Record<string, unknown>)?.count ?? 0),
      labels: (p.profiles as Record<string, unknown>)?.labels as string[] ?? [],
    }));

    const aliasesRaw = data.aliases ?? {};
    const aliases: Record<string, string> = {};
    for (const [k, v] of Object.entries(aliasesRaw)) {
      aliases[k] = String(v);
    }

    return {
      agentId: agent.agentId,
      containerName: agent.containerName,
      state: agent.state,
      defaultModel: String(data.defaultModel ?? ''),
      fallbacks: (data.fallbacks ?? []).map(String),
      allowed: (data.allowed ?? []).map(String),
      aliases,
      providers,
    };
  } catch {
    return null;
  }
}

/** Get available models from an agent */
function getAgentModels(container: string): GatewayModel[] {
  const raw = dockerExec(container, 'openclaw models list --json', 20000);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const models: Record<string, unknown>[] = parsed.models ?? parsed ?? [];
    return models
      .filter((m: Record<string, unknown>) => m.available !== false && !m.missing)
      .map((m: Record<string, unknown>) => ({
        key: String(m.key ?? ''),
        provider: String(m.key ?? '').split('/')[0] || 'unknown',
        model: String(m.name ?? String(m.key ?? '').split('/').slice(1).join('/')),
        available: m.available !== false,
      }));
  } catch {
    return [];
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const timestamp = Date.now();

    // Only Olympus-managed agents (AGENT_ID label)
    const agentsRaw = getAgents();
    const agents = agentsRaw
      .map((a) => getAgentStatus(a))
      .filter(Boolean) as GatewayAgentStatus[];

    // Aggregate models from all agents (deduplicated by key)
    const modelMap = new Map<string, GatewayModel>();
    for (const agent of agents) {
      for (const m of getAgentModels(agent.containerName)) {
        if (!modelMap.has(m.key)) modelMap.set(m.key, m);
      }
    }
    const allModels = Array.from(modelMap.values());
    const availableModels = allModels.filter((m) => m.available);

    // Aggregate aliases from all agents
    const combinedAliases: Record<string, string[]> = {};
    for (const agent of agents) {
      for (const [alias, model] of Object.entries(agent.aliases)) {
        if (!combinedAliases[alias]) combinedAliases[alias] = [];
        if (!combinedAliases[alias].includes(model)) {
          combinedAliases[alias].push(model);
        }
      }
    }

    // First agent is the "primary" for core model settings
    const primaryAgent = agents[0] ?? null;

    // API keys from the first agent's providers
    const apiKeys: ApiKeyStatus[] = [];
    if (primaryAgent) {
      for (const p of primaryAgent.providers) {
        // We can't query apiKey presence from openclaw models status (it's redacted).
        // Mark as configured if the provider appears in the auth list.
        apiKeys.push({
          provider: p.provider,
          configured: p.profiles > 0,
        });
      }
    }

    // Models by provider
    const byProvider = allModels.reduce<Record<string, number>>((acc, m) => {
      acc[m.provider] = (acc[m.provider] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      timestamp,
      gateway: 'Olympus Model Gateway',
      status: 'online',
      models: {
        total: allModels.length,
        available: availableModels.length,
        byProvider: Object.entries(byProvider).map(([provider, count]) => ({ provider, count })),
        list: allModels,
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
      aliases: combinedAliases,
      coreModel: primaryAgent
        ? {
            defaultModel: primaryAgent.defaultModel,
            fallbacks: primaryAgent.fallbacks,
          }
        : null,
      apiKeys: {
        configured: apiKeys.filter((k) => k.configured).map((k) => k.provider),
        all: apiKeys,
      },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
