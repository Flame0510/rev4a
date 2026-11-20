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
import { withAgentConfigLock } from '@/lib/agent-config-lock';
import { dockerExecWithInput } from '@/lib/docker-exec';
import { gatewayCliArgv } from '@/lib/gateway-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readProviderKeys } from './provider/keys';
import { bundledCatalogueStatus, loadOfferedModels, type ModelConfigEntry } from '@/lib/model-catalogue';
import { singleFileFromTar } from '@/lib/container-file';
import { detectProviderGatewayUrl } from '@/lib/docker-utils';
import { isSupportedVersion, modelInputFor, parseOpenClawVersion } from '@/lib/agent-versions';
import { activeUpdateAgentIds } from '@/lib/agent-update-state';
import { activeRecreateAgentIds } from '@/lib/agent-recreate-state';
import { activeRestoreAgentIds } from '@/lib/agent-restore-state';
import { activeEditAgentIds } from '@/lib/agent-edit-state';
import { getAgentDisplayNames } from '@/lib/agent-names';
import { priceAt, type ModelCost } from '@/lib/model-pricing';
import { AGENT_HEADER } from '@/lib/proxy-usage';
import { deriveAgentProxyToken } from '@/lib/agent-proxy-token';

const PROVIDER_GATEWAY_BASE_URL = detectProviderGatewayUrl();

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert internal modality string (e.g. "text+image+file->text") to
 * OpenClaw `input` array. Filters out values not in the allowed set
 * (text | image | video | audio).
 */
/**
 * Model `input` values an agent's OpenClaw version accepts. The list is per version
 * (lib/agent-versions.json): a value the running Gateway does not know invalidates the
 * whole generated catalogue ("model catalog load issue"), and the accepted set grows
 * between releases.
 */
function modalityToInput(modality: string, version?: string | null): string[] {
  const allowed = new Set(modelInputFor(version));
  const arrowIdx = modality.indexOf('->');
  const left = arrowIdx >= 0 ? modality.slice(0, arrowIdx) : modality;
  return left.split('+').map((s) => s.trim()).filter((s) => allowed.has(s));
}

/** Where the image entrypoint records the version an agent last started on. */
const LAST_VERSION_PATH = '/root/.openclaw/.last-version';

/**
 * The OpenClaw version a container runs, for its model `input` list. Best-effort and
 * synchronous: the image tag when it names a version, else the `.last-version` file the
 * entrypoint writes (through `docker exec` when running, `docker cp` when stopped).
 * Null when nothing says — the caller then falls back to the newest version's list.
 */
function containerVersionSync(name: string): string | null {
  try {
    const image = execFileSync('docker', ['inspect', '--format', '{{.Config.Image}}', name], {
      timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const fromTag = parseOpenClawVersion(image);
    if (fromTag && isSupportedVersion(fromTag)) return fromTag;
  } catch { /* no such container or no image: fall through */ }
  try {
    const raw = execFileSync('docker', ['exec', name, 'cat', LAST_VERSION_PATH], {
      timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const running = parseOpenClawVersion(raw);
    if (running && isSupportedVersion(running)) return running;
  } catch { /* not running or no file: try the stopped path */ }
  try {
    const file = singleFileFromTar(execFileSync('docker', ['cp', `${name}:${LAST_VERSION_PATH}`, '-'], {
      timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const stopped = parseOpenClawVersion(file.body.toString('utf-8'));
    if (stopped && isSupportedVersion(stopped)) return stopped;
  } catch { /* nothing to read */ }
  return null;
}

/** One model of the `rev4a` block, as OpenClaw's `models.providers.*.models[]` takes it. */
export interface Rev4aModelEntry { id: string; name: string; input?: string[]; cost?: ModelCost }

/**
 * `cost` is what makes OpenClaw price every call itself (per call, session and day, the
 * cache split out): the rates in force now, from model-pricing.json. A model without a
 * price gets none, and OpenClaw counts its calls as "missing cost" instead of $0. A
 * vendor priced by time of day is re-synced at each change of rate
 * (lib/price-schedule-sync.ts); OpenClaw keeps the cost it recorded at call time.
 */
function getActiveRev4aModels(version?: string | null): Rev4aModelEntry[] {
  const now = new Date();
  return loadOfferedModels()
    .map((m) => {
      const entry: Rev4aModelEntry = { id: m.id, name: m.name };
      if (m.modality) entry.input = modalityToInput(m.modality, version);
      const cost = priceAt(m.id, now);
      if (cost) entry.cost = cost;
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
interface AgentContainer { name: string; running: boolean; agentId: string }

/**
 * AGENT_IDs whose volume is being archived by a cold backup (lib/cold-backup.ts). Their
 * config must not change while tar reads the volume; the next sync catches them up.
 */
function agentsUnderBackup(): Set<string> {
  try {
    const raw = execSync(
      `docker ps --filter "label=rev4a.backup.agent" --format '{{.Label "rev4a.backup.agent"}}'`,
      { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return new Set(raw ? raw.split('\n').map((s) => s.trim()).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

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
      `docker ps -a --filter "label=AGENT_ID" --format '{{.Names}}\t{{.State}}\t{{.Label "AGENT_ID"}}'`,
      { timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (e) {
    throw new Error(firstLine(e));
  }
  if (!raw) return [];
  return raw.split('\n')
    .map((line) => {
      const [name, state, agentId] = line.split('\t');
      return { name: (name ?? '').trim(), running: (state ?? '').trim() === 'running', agentId: (agentId ?? '').trim() };
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
export interface Rev4aProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  /** Compatibility identity header for older Rev4a readers; token identity takes precedence. */
  headers: Record<string, string>;
  models: Rev4aModelEntry[];
}

/**
 * `agentId` binds the API credential to the container's identity. Without one the generic
 * block keeps the shared key and no header (legacy, metered as 'unknown').
 */
export function buildRev4aProviderConfig(version?: string | null, agentId?: string | null): Rev4aProviderConfig {
  const providerKeys = readProviderKeys();
  const rev4aApiKey = providerKeys['rev4a'] || '';
  const activeModels = getActiveRev4aModels(version);
  return {
    baseUrl: PROVIDER_GATEWAY_BASE_URL,
    apiKey: agentId == null ? rev4aApiKey : deriveAgentProxyToken(rev4aApiKey, agentId),
    api: 'openai-completions',
    headers: agentId ? { [AGENT_HEADER]: agentId } : {},
    models: activeModels,
  };
}

/**
 * The AGENT_ID label used for the token and compatibility header; the container name
 * only when there is no label (or Docker cannot say).
 */
function containerAgentIdSync(name: string): string {
  try {
    const label = execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "AGENT_ID"}}', name], {
      timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (label && label !== '<no value>') return label;
  } catch { /* fall back to the name */ }
  return name;
}

/**
 * Write `models.providers.rev4a` into one running container.
 *
 * Throws instead of writing when the catalogue could not be read: an unreadable
 * catalogue is not an empty one, and patching it in would strip every model from
 * the agent. `syncAllAgents()` refuses for the same reason.
 *
 * Async, and queued behind every other writer of this agent's openclaw.json
 * (lib/agent-config-lock.ts): `config patch` is a read-modify-write of the file.
 *
 * No gateway restart: `config patch` reports "Change will apply without restarting
 * the gateway" for a models-only patch, and the Gateway watches openclaw.json with
 * gateway.reload defaulting to hybrid.
 */
export async function patchRev4aProvider(container: string): Promise<void> {
  if (bundledCatalogueStatus() === 'unavailable') {
    throw new Error('models.config.json could not be read; models.providers.rev4a left unchanged');
  }
  // The agent's own version: an older release rejects `input` values it does not know.
  const input = JSON.stringify({ models: { providers: { rev4a: buildRev4aProviderConfig(containerVersionSync(container), containerAgentIdSync(container)) } } });
  // Through dockerExecWithInput: the patch goes in on stdin, and the in-container timeout
  // wrapper kills `config patch` at its deadline, so a slow patch cannot keep writing after
  // the lock has moved on to the next writer.
  await withAgentConfigLock(container, async () => {
    try {
      await dockerExecWithInput(container, gatewayCliArgv(['config', 'patch', '--stdin']), input, { timeoutMs: 15000 });
    } catch (e) {
      throw new Error(String((e as Error).message || e).split('\n')[0]);
    }
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
export async function syncAllAgents(): Promise<SyncOutcome> {
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
    try {
      if (getAgentContainers().length === 0) {
        outcome.ok = true;
        outcome.summary = 'No agent containers to sync.';
        return outcome;
      }
    } catch {
      // Docker being unreachable cannot prove there are no agents: keep reporting
      // the missing key below, rather than replacing it with a Docker error.
    }
    outcome.configError = 'Gateway key not found in provider-keys.json (add a "rev4a" entry)';
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
  const underBackup = agentsUnderBackup();
  // Any long operation replaces or rewrites the container/config: skip the agent.
  let busyAgents = new Set<string>();
  try {
    busyAgents = new Set([
      ...activeUpdateAgentIds(),
      ...activeRecreateAgentIds(),
      ...activeRestoreAgentIds(),
      ...activeEditAgentIds(),
    ]);
  } catch {
    // No operation state readable: nothing to skip on that account.
  }
  for (const container of containers) {
    if (busyAgents.has(container.agentId)) {
      outcome.failed.push({ container: container.name, error: 'an operation of this agent is running; it applies Rev4a config itself' });
      continue;
    }
    if (underBackup.has(container.agentId)) {
      outcome.failed.push({ container: container.name, error: 'a cold backup of this agent is running; sync again once it finishes' });
      continue;
    }
    try {
      // Per agent: the `input` list follows the version that agent runs, so an agent on
      // an older supported release never receives a modality value it would reject.
      // Read + rewrite of the whole file: one hold of the agent's config lock around both.
      await withAgentConfigLock(container.name, async () => {
        syncContainer(container, buildRev4aProviderConfig(containerVersionSync(container.name), container.agentId || container.name));
      });
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
    // The agent's display name first, the container in parentheses; a failed lookup keeps the container name.
    const display = await getAgentDisplayNames(outcome.failed.map((f) => f.container)).catch(() => new Map<string, string>());
    const names = outcome.failed.map((f) => {
      const n = display.get(f.container);
      return `${n && n !== f.container ? `${n} (${f.container})` : f.container} (${f.error})`;
    }).join(', ');
    outcome.summary = `Synced ${outcome.synced.length} of ${outcome.total} agent(s)${stoppedNote(outcome)}. Not applied to: ${names}.`;
  }
  return outcome;
}

/**
 * Internal: write models.providers.rev4a into one container's openclaw.json.
 */
function syncContainer(
  container: AgentContainer,
  rev4aProviderConfig: Rev4aProviderConfig,
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
