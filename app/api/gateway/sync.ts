/**
 * Agent Gateway Sync
 *
 * Syncs the models.providers.rev4a config block to all agent containers
 * (or a single container) without touching model references (primary/fallback).
 *
 * Import and call:
 *   syncAllAgents()          — sync all containers with AGENT_ID label
 *   syncAgent('container')   — sync a single container
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import { readProviderKeys } from './provider/keys';
import { loadModelsConfig, type ModelConfigEntry } from '@/lib/model-catalogue';
import { detectProviderGatewayUrl } from '@/lib/docker-utils';

const PROVIDER_GATEWAY_BASE_URL = detectProviderGatewayUrl();

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getActiveRev4aModels(models: ModelConfigEntry[]): { id: string; name: string }[] {
  const providerKeys = readProviderKeys();
  const configuredProviders = Object.keys(providerKeys);
  return models
    .filter((m) => m.enabled && configuredProviders.includes(m.provider))
    .map((m) => ({ id: m.id, name: m.name }));
}

function getAgentContainers(): string[] {
  try {
    const raw = execSync(
      `docker ps --filter "label=AGENT_ID" --format '{{.Names}}'`,
      { timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf-8' },
    ).trim();
    if (!raw) return [];
    return raw.split('\n');
  } catch {
    return [];
  }
}

function readContainerJson(container: string, remotePath: string): Record<string, unknown> {
  try {
    const raw = execSync(
      `docker exec ${container} cat ${remotePath}`,
      { timeout: 8000, maxBuffer: 512 * 1024, encoding: 'utf-8' },
    );
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeContainerJson(container: string, remotePath: string, data: Record<string, unknown>): void {
  const jsonStr = JSON.stringify(data, null, 2);
  // Use shell-quoted heredoc to avoid word-splitting on paths with spaces
  execSync(
    `docker exec -i ${container} sh -c "cat > '${remotePath}'"`,
    { timeout: 10000, maxBuffer: 1024 * 1024, input: jsonStr },
  );
}

function restartContainerGateway(container: string): string | null {
  try {
    execSync(`docker exec ${container} openclaw gateway restart`, { timeout: 15000, maxBuffer: 64 * 1024 });
    return null;
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return err.stderr?.toString().trim() || err.message || 'unknown error';
  }
}

/* ------------------------------------------------------------------ */
/*  Sync functions                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the models.providers.rev4a config object from local state.
 * Shared between the create wizard and syncAgent — single source of truth
 * for the provider block injected into every agent container.
 */
export function buildRev4aProviderConfig(): { baseUrl: string; apiKey: string; api: string; models: { id: string; name: string }[] } {
  const providerKeys = readProviderKeys();
  const rev4aApiKey = providerKeys['rev4a'] || '';
  const allModels = loadModelsConfig();
  const activeModels = getActiveRev4aModels(allModels);
  return {
    baseUrl: PROVIDER_GATEWAY_BASE_URL,
    apiKey: rev4aApiKey,
    api: 'openai-completions',
    models: activeModels,
  };
}

/**
 * Sync models.providers.rev4a to all agent containers.
 * Does NOT touch agents.defaults.model or agents.list[].model.
 */
export function syncAllAgents(): string[] {
  const rev4aProviderConfig = buildRev4aProviderConfig();
  if (!rev4aProviderConfig.apiKey) {
    return ['ERROR: REV4A_API_KEY not found in provider-keys.json (add "rev4a" key)'];
  }

  const containers = getAgentContainers();
  const results: string[] = [`Active models: ${rev4aProviderConfig.models.length} across ${containers.length} agent(s)`];

  for (const container of containers) {
    try {
      const result = syncContainer(container, rev4aProviderConfig);
      results.push(result);
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      results.push(`${container}: ERROR ${err.stderr || err.message || 'unknown'}`);
    }
  }

  if (containers.length === 0) {
    results.push('No agent containers found');
  }

  return results;
}

/**
 * Sync models.providers.rev4a to a single agent container.
 * Does NOT touch agents.defaults.model or agents.list[].model.
 */
export function syncAgent(containerName: string): string {
  const rev4aProviderConfig = buildRev4aProviderConfig();
  if (!rev4aProviderConfig.apiKey) {
    throw new Error('REV4A_API_KEY not found in provider-keys.json (add "rev4a" key)');
  }
  return syncContainer(containerName, rev4aProviderConfig);
}

/**
 * Internal: write models.providers.rev4a to one container and restart its gateway.
 */
function syncContainer(
  container: string,
  rev4aProviderConfig: { baseUrl: string; apiKey: string; api: string; models: { id: string; name: string }[] },
): string {
  const remotePath = '/root/.openclaw/openclaw.json';
  const config = readContainerJson(container, remotePath) as Record<string, unknown>;

  // Clean up stale files from old versions
  try {
    execSync(
      `docker exec ${container} sh -c 'rm -f /root/.openclaw/agents/main/agent/models.json /root/.openclaw/agents/main/agent/auth-profiles.json'`,
      { timeout: 5000 },
    );
  } catch {
    // non-fatal
  }

  // Write/overwrite models.providers.rev4a — do NOT touch agents.*
  const models = (config.models as Record<string, unknown>) || {};
  if (!models.providers) models.providers = {};
  (models.providers as Record<string, unknown>)['rev4a'] = rev4aProviderConfig;
  config.models = models;

  writeContainerJson(container, remotePath, config);

  const gwError = restartContainerGateway(container);
  if (gwError) {
    return `${container}: file updated but gateway restart failed: ${gwError}`;
  }
  return `${container}: synced + restarted OK`;
}
