/**
 * Agent Gateway Sync
 *
 * Syncs the models.providers.rev4a config block to all agent containers
 * without touching model references (primary/fallback).
 *
 * Import and call:
 *   syncAllAgents()          — sync all containers with AGENT_ID label
 *
 * A single-container `syncAgent()` used to be exported too. Nothing called it —
 * the create route builds the block with `buildRev4aProviderConfig()` and writes
 * it with `openclaw config patch` itself — so it was removed.
 */
import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readProviderKeys } from './provider/keys';
import { bundledCatalogueStatus, loadOfferedModels, type ModelConfigEntry } from '@/lib/model-catalogue';
import { singleFileFromTar } from '@/lib/container-file';
import { detectProviderGatewayUrl } from '@/lib/docker-utils';

const PROVIDER_GATEWAY_BASE_URL = detectProviderGatewayUrl();

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert internal modality string (e.g. "text+image+file->text") to
 * OpenClaw `input` array. Filters out values not in the allowed set
 * (text | image | video | audio).
 */
const ALLOWED_INPUT = new Set(['text', 'image', 'video', 'audio']);

function modalityToInput(modality: string): string[] {
  const arrowIdx = modality.indexOf('->');
  const left = arrowIdx >= 0 ? modality.slice(0, arrowIdx) : modality;
  return left.split('+').map((s) => s.trim()).filter((s) => ALLOWED_INPUT.has(s));
}

function getActiveRev4aModels(): { id: string; name: string; input?: string[] }[] {
  return loadOfferedModels()
    .map((m) => {
      const entry: { id: string; name: string; input?: string[] } = { id: m.id, name: m.name };
      if (m.modality) entry.input = modalityToInput(m.modality);
      return entry;
    });
}

/** A readable cause from a failed child process: its stderr if any, else the message. */
function firstLine(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  const text = (err.stderr ? err.stderr.toString() : '') || err.message || 'unknown error';
  return text.trim().split('\n')[0];
}

/** A container carrying an AGENT_ID label, and whether it is running. */
interface AgentContainer { name: string; running: boolean }

/**
 * Every container carrying an AGENT_ID label, running or stopped.
 *
 * Throws when Docker cannot be asked. It used to catch that and return `[]`,
 * which made "the Docker daemon is not running" indistinguishable from "there are
 * no agents": a model toggle made while Docker was stopped synced to nobody and
 * still reported success. An empty list now means only the second.
 *
 * Stopped agents are included on purpose. This used to run `docker ps` without
 * `-a`, so a catalogue change made while an agent was stopped skipped it, and
 * starting it later brought back the old catalogue until someone ran Sync All.
 */
function getAgentContainers(): AgentContainer[] {
  let raw: string;
  try {
    raw = execSync(
      `docker ps -a --filter "label=AGENT_ID" --format '{{.Names}}\t{{.State}}'`,
      { timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (e) {
    throw new Error(firstLine(e));
  }
  if (!raw) return [];
  return raw.split('\n')
    .map((line) => {
      const [name, state] = line.split('\t');
      return { name: (name ?? '').trim(), running: (state ?? '').trim() === 'running' };
    })
    .filter((c) => c.name);
}

/**
 * Why Docker cannot be asked right now, or undefined when it can.
 *
 * For callers that must decide *before* committing a change whether its sync can
 * happen at all. A model toggle made while Docker was unreachable used to be saved
 * and then reach no container, leaving the Gateway's checkboxes out of step with
 * what the agents hold; checking first lets it be refused cleanly instead.
 */
export function dockerUnreachableReason(): string | undefined {
  try {
    getAgentContainers();
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}


/**
 * Read and parse a container's JSON config, running or stopped.
 *
 * Throws on any failure. It used to return `{}`, and the caller wrote that back
 * with only the provider block added — so a single timed-out read replaced an
 * agent's whole config (agents, gateway, channels) with `{ models: { providers:
 * { rev4a } } }`. An empty object is refused for the same reason. Also returns
 * the file mode, so a stopped container's file is written back unchanged in that
 * respect.
 */
function readContainerJson(container: AgentContainer, remotePath: string): { config: Record<string, unknown>; mode: number } {
  let raw: string;
  let mode = 0o600;
  if (container.running) {
    raw = execFileSync('docker', ['exec', container.name, 'cat', remotePath], {
      timeout: 8000, maxBuffer: 512 * 1024, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    const file = singleFileFromTar(execFileSync('docker', ['cp', `${container.name}:${remotePath}`, '-'], {
      timeout: 8000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    raw = file.body.toString('utf-8');
    mode = file.mode;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not the parser's message: V8 quotes a slice of the input, this file holds
    // tokens, and the error ends up in the sync summary shown in the browser.
    throw new Error(`${remotePath} is not valid JSON; refusing to overwrite it`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error(`${remotePath} is empty or not a JSON object; refusing to overwrite it`);
  }
  return { config: parsed as Record<string, unknown>, mode };
}

/**
 * Write a container's JSON config, running or stopped.
 *
 * Running: through `docker exec`, truncating the file in place so its mode and
 * owner stay as they are, and OpenClaw hot-applies the change. Stopped: through
 * `docker cp`, the only way to reach it; the file is staged on the host with the
 * original mode, lands on the agent's volume, and is read at next start.
 */
function writeContainerJson(container: AgentContainer, remotePath: string, data: Record<string, unknown>, mode: number): void {
  const jsonStr = JSON.stringify(data, null, 2);
  if (container.running) {
    execFileSync('docker', ['exec', '-i', container.name, 'sh', '-c', 'cat > "$1"', 'sh', remotePath], {
      timeout: 10000, maxBuffer: 1024 * 1024, input: jsonStr, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-sync-'));
  const staged = path.join(dir, path.basename(remotePath));
  try {
    fs.writeFileSync(staged, jsonStr);
    fs.chmodSync(staged, mode);
    execFileSync('docker', ['cp', staged, `${container.name}:${remotePath}`], {
      timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


/* ------------------------------------------------------------------ */
/*  Sync functions                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the models.providers.rev4a config object from local state.
 * Shared between the create route and syncAllAgents — single source of truth
 * for the provider block injected into every agent container.
 */
export function buildRev4aProviderConfig(): { baseUrl: string; apiKey: string; api: string; models: { id: string; name: string; input?: string[] }[] } {
  const providerKeys = readProviderKeys();
  const rev4aApiKey = providerKeys['rev4a'] || '';
  const activeModels = getActiveRev4aModels();
  return {
    baseUrl: PROVIDER_GATEWAY_BASE_URL,
    apiKey: rev4aApiKey,
    api: 'openai-completions',
    models: activeModels,
  };
}

/**
 * Write `models.providers.rev4a` into one running container.
 *
 * Throws instead of writing when the catalogue could not be read: an unreadable
 * catalogue is not an empty one, and patching it in would strip every model from
 * the agent. `syncAllAgents()` refuses for the same reason.
 *
 * No gateway restart: `config patch` reports "Change will apply without restarting
 * the gateway" for a models-only patch, and the Gateway watches openclaw.json with
 * gateway.reload defaulting to hybrid.
 */
export function patchRev4aProvider(container: string): void {
  if (bundledCatalogueStatus() === 'unavailable') {
    throw new Error('models.config.json could not be read; models.providers.rev4a left unchanged');
  }
  const input = JSON.stringify({ models: { providers: { rev4a: buildRev4aProviderConfig() } } });
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'openclaw config patch --stdin'], {
    timeout: 15000,
    stdio: 'pipe',
    input,
  });
}

/** What a sync did, container by container. */
export interface SyncOutcome {
  /**
   * True only when every agent container received the catalogue. Zero agents is
   * ok — there is nothing to sync, which is the normal state on first run.
   */
  ok: boolean;
  /** Models written into each container. */
  activeModels: number;
  /** Agent containers found. */
  total: number;
  synced: string[];
  /** Of `synced`, the ones not running (stopped, paused, created): written with `docker cp`. Applied when started, or resumed. */
  stopped: string[];
  failed: { container: string; error: string }[];
  /** Docker could not list containers at all, so nothing was attempted. */
  dockerError?: string;
  /** The catalogue block could not be built, so nothing was attempted. */
  configError?: string;
  /** One line for a person. Built here so every caller says the same thing. */
  summary: string;
}

/** ", 2 of them not running" — those apply the change later, which is worth saying. */
function stoppedNote(outcome: SyncOutcome): string {
  return outcome.stopped.length ? `, ${outcome.stopped.length} of them not running` : '';
}

/**
 * Push the offered catalogue into every agent container, and say exactly what
 * happened.
 *
 * Returns an outcome instead of throwing: callers run this *after* committing a
 * change — a key saved, a model toggled — and a failed propagation must not be
 * reported as a failed save, because the save stands. The old signature returned
 * loose strings that no caller inspected, so a sync that reached no container
 * surfaced as success.
 */
export function syncAllAgents(): SyncOutcome {
  const rev4aProviderConfig = buildRev4aProviderConfig();
  const outcome: SyncOutcome = {
    ok: false,
    activeModels: rev4aProviderConfig.models.length,
    total: 0,
    synced: [],
    stopped: [],
    failed: [],
    summary: '',
  };

  if (!rev4aProviderConfig.apiKey) {
    outcome.configError = 'REV4A_API_KEY not found in provider-keys.json (add "rev4a" key)';
    outcome.summary = `Not applied to any agent: ${outcome.configError}.`;
    return outcome;
  }

  // A catalogue that could not be read is not an empty catalogue: pushing it would
  // strip every model from every agent.
  if (bundledCatalogueStatus() === 'unavailable') {
    outcome.configError = 'models.config.json could not be read, so there is no catalogue to push';
    outcome.summary = `Not applied to any agent: ${outcome.configError}.`;
    return outcome;
  }

  let containers: AgentContainer[];
  try {
    containers = getAgentContainers();
  } catch (e) {
    outcome.dockerError = (e as Error).message;
    outcome.summary = `Not applied to any agent: Docker is unreachable (${outcome.dockerError}).`;
    return outcome;
  }

  outcome.total = containers.length;
  for (const container of containers) {
    try {
      syncContainer(container, rev4aProviderConfig);
      outcome.synced.push(container.name);
      if (!container.running) outcome.stopped.push(container.name);
    } catch (e: unknown) {
      outcome.failed.push({ container: container.name, error: firstLine(e) });
    }
  }

  outcome.ok = outcome.failed.length === 0;
  if (outcome.total === 0) {
    outcome.summary = 'No agent containers to sync.';
  } else if (outcome.ok) {
    outcome.summary = `Synced ${outcome.synced.length} of ${outcome.total} agent(s)${stoppedNote(outcome)}.`;
  } else {
    const names = outcome.failed.map((f) => `${f.container} (${f.error})`).join(', ');
    outcome.summary = `Synced ${outcome.synced.length} of ${outcome.total} agent(s)${stoppedNote(outcome)}. Not applied to: ${names}.`;
  }
  return outcome;
}

/**
 * Internal: write models.providers.rev4a into one container's openclaw.json.
 */
function syncContainer(
  container: AgentContainer,
  rev4aProviderConfig: { baseUrl: string; apiKey: string; api: string; models: { id: string; name: string }[] },
): string {
  const remotePath = '/root/.openclaw/openclaw.json';
  // Read first. If this throws, the container is reported as failed and nothing
  // below runs — in particular nothing is written.
  const { config, mode } = readContainerJson(container, remotePath);

  // Clean up stale files from old versions. Needs exec, so running containers
  // only; a stopped one is cleaned on the first sync after it starts.
  if (container.running) {
    try {
      execFileSync('docker', ['exec', container.name, 'rm', '-f',
        '/root/.openclaw/agents/main/agent/models.json',
        '/root/.openclaw/agents/main/agent/auth-profiles.json'], { timeout: 5000, stdio: 'ignore' });
    } catch {
      // non-fatal
    }
  }

  // Write/overwrite models.providers.rev4a — do NOT touch agents.*
  const models = (config.models as Record<string, unknown>) || {};
  if (!models.providers) models.providers = {};
  (models.providers as Record<string, unknown>)['rev4a'] = rev4aProviderConfig;
  config.models = models;

  writeContainerJson(container, remotePath, config, mode);

  // No gateway restart: this only writes models.providers.rev4a, and the Gateway
  // watches openclaw.json and hot-applies it. OpenClaw's own config tooling says
  // so out loud — "Change will apply without restarting the gateway" — and its
  // docs put `models` in the no-restart column, with `gateway.reload` defaulting
  // to `hybrid`, which additionally restarts by itself for the changes that do
  // need it. Verified against a live agent: every agent here leaves
  // `gateway.reload` unset, so they all run that default.
  //
  // The restart used to cost ~7.5s per container, serially — roughly 52s of
  // fully blocked event loop on a seven-agent host, every time a provider key or
  // model toggle was saved, to do something the Gateway had already done.
  return `${container.name}: synced`;
}
