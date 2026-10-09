/**
 * Subscriptions: which agents are signed in to a ChatGPT (Codex) account, and which of
 * them use a subscription model as their primary.
 *
 * The OAuth profile lives in the agent's own volume (`~/.openclaw/state/openclaw.sqlite`).
 * Status is read with ONE `docker exec node -e` inside the agent (STATUS_SCRIPT, about
 * 0.5 s): it prints the profile ids, emails, plan and expiry and the agent's model, never a
 * token. An `openclaw` CLI call boots every plugin (about 7 s), so the CLI is only the
 * fallback for an older layout and the way to list models, disconnect and write the model:
 *
 *   models list --provider openai --json     the models the account offers (cached 10 min)
 *   models auth logout <profile> --yes       disconnect
 *   config patch --stdin                     `agents.defaults.model` only
 *
 * The model is read first (fast read), written, and read back; a config that cannot be read
 * is never written over. Status is not cached: every row of the page reads its own agent.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dockerExec, dockerExecNoFail, dockerExecWithInput, mapWithConcurrency } from '@/lib/docker-exec';
import { isValidAgentId } from '@/lib/container';
import {
  parseAuthList,
  parseModelList,
  parseStatusJson,
  STATUS_SCRIPT_SRC,
  stopSubscriptionModel,
  isSubscriptionModel,
  normalizeModel,
  type AuthProfile,
  type SubscriptionModel,
  type AgentModelRef,
} from '@/lib/subscriptions-parse';

const execFileAsync = promisify(execFile);

export const PROVIDER_ID = 'openai';
export const PROVIDER_NAME = 'ChatGPT (Codex)';

const CONFIG_PATH = '/root/.openclaw/openclaw.json';
const MODELS_TTL_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 25_000;
const CONCURRENCY = 4;

/** An error that carries the HTTP status a route should answer with. */
export class SubscriptionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AgentContainer {
  agentId: string;
  container: string;
  running: boolean;
  /** The agent's display name (its AGENT_NAME env, as on the Agents page); null when unset or unreadable. */
  displayName: string | null;
}

export interface AgentSubscription {
  agentId: string;
  name: string;
  /** The container name, shown as a small secondary line when it differs from the name. */
  container: string;
  running: boolean;
  connected: boolean;
  email: string | null;
  /** ChatGPT plan ("Plus", "Pro"), capitalised; null when unknown. */
  plan: string | null;
  expiresAt: string | null;
  usesSubscription: boolean;
  primary: string | null;
  fallbacks: string[];
  error: string | null;
}

/** What `GET /api/subscriptions` returns at once: who the agents are, without asking any of them. */
export interface ProviderListView {
  id: string;
  name: string;
  agents: { agentId: string; name: string; container: string; running: boolean }[];
}

/** Every agent container, through one `docker ps`. A running container wins over a stopped twin. */
export async function listAgentContainers(): Promise<AgentContainer[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'docker',
      ['ps', '-a', '--filter', 'label=AGENT_ID', '--format', '{{.Label "AGENT_ID"}}\t{{.Names}}\t{{.State}}'],
      { encoding: 'utf8', timeout: 8000 },
    ));
  } catch (e) {
    throw new SubscriptionError(503, `Docker is unreachable: ${(e as Error).message.split('\n')[0]}`);
  }
  const byId = new Map<string, AgentContainer>();
  for (const line of stdout.trim().split('\n')) {
    const [id, name, state] = line.split('\t');
    if (!name?.trim()) continue;
    const agentId = id?.trim() || name.trim();
    const row = { agentId, container: name.trim(), running: state?.trim() === 'running', displayName: null as string | null };
    const prev = byId.get(agentId);
    if (!prev || (!prev.running && row.running)) byId.set(agentId, row);
  }
  const rows = [...byId.values()];
  // Display names live in each container's AGENT_NAME env (the Agents page reads the same).
  // One inspect for all; a failure only costs the names, the agents are still listed.
  if (rows.length) {
    try {
      const { stdout: env } = await execFileAsync(
        'docker',
        // Prints only AGENT_NAME, never the rest of the env (it holds the gateway token).
        ['inspect', '--format', '{{.Name}}{{range .Config.Env}}{{$p := split . "="}}{{if eq (index $p 0) "AGENT_NAME"}}\t{{.}}{{end}}{{end}}', ...rows.map((r) => r.container)],
        { encoding: 'utf8', timeout: 8000 },
      );
      const names = new Map<string, string>();
      for (const line of env.trim().split('\n')) {
        const [cname, ...vars] = line.split('\t');
        const v = vars.find((e) => e.startsWith('AGENT_NAME='));
        const display = v ? v.slice('AGENT_NAME='.length).trim() : '';
        if (cname && display) names.set(cname.replace(/^\//, ''), display);
      }
      for (const r of rows) r.displayName = names.get(r.container) ?? null;
    } catch { /* names stay null */ }
  }
  return rows.sort((a, b) => (a.displayName || a.agentId).localeCompare(b.displayName || b.agentId));
}

export async function findAgentContainer(agentId: unknown): Promise<AgentContainer> {
  if (typeof agentId !== 'string' || !isValidAgentId(agentId)) throw new SubscriptionError(400, 'Invalid agent id');
  const found = (await listAgentContainers()).find((a) => a.agentId === agentId);
  if (!found) throw new SubscriptionError(404, `No container found with AGENT_ID '${agentId}'`);
  return found;
}

function cliProblem(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/unknown command|too many arguments|unknown option|not a (known )?command|has no command/i.test(msg)) {
    return "This agent's OpenClaw version does not support subscriptions. Update the agent first.";
  }
  if (/unexpected format/i.test(msg)) return "The agent's OpenClaw answered in an unexpected format.";
  if (/timed out/i.test(msg)) return 'The agent did not answer in time.';
  return 'Could not read the subscription status from this agent.';
}

// ---- fast status read -------------------------------------------------------------------

/**
 * Runs inside the agent container with `node -e` (argv form: a fixed constant, nothing is
 * interpolated). It opens the agent's state database read-only, reads the auth profile store
 * and `agents.defaults.model`, and prints ONE JSON line with only the fields the page needs.
 * `access`, `refresh` and `accountId` are never copied: the tokens do not leave the container.
 * It takes about 0.5 s; an `openclaw` CLI call boots every plugin and takes about 7 s.
 *
 * `{"legacy":true}` means this agent has another layout (no node:sqlite, no state database,
 * no profile table): the caller then falls back to the CLI. A missing profile row is simply
 * no profiles. A config that cannot be read gives `model: null` and `error`.
 */
export const STATUS_SCRIPT = STATUS_SCRIPT_SRC;

/** What one agent says about its subscription and its model. */
export interface AgentState {
  /** ChatGPT (OAuth) profiles only: an API-key `openai:` profile is the operator's own. */
  profiles: AuthProfile[];
  /** `agents.defaults.model`; null when the configuration could not be read. */
  model: AgentModelRef | null;
}

const isChatgptProfile = (p: { id: string; type: string | null }): boolean => p.id.startsWith(`${PROVIDER_ID}:`) && p.type === 'oauth';

async function readStateFast(container: string): Promise<AgentState | null> {
  let out: string;
  try {
    out = await dockerExec(container, ['node', '-e', STATUS_SCRIPT], { timeoutMs: 12_000 });
  } catch {
    return null;
  }
  const s = parseStatusJson(out);
  if (!s || s.legacy) return null;
  return { profiles: s.profiles.filter(isChatgptProfile), model: s.error ? null : s.model };
}

/** The slow path for an agent whose layout the fast read does not know: two OpenClaw CLI calls. */
async function readStateSlow(container: string): Promise<AgentState> {
  const [profilesR, modelR] = await Promise.allSettled([readProfilesCli(container), readDefaultModelCat(container)]);
  if (profilesR.status === 'rejected') throw profilesR.reason;
  return { profiles: profilesR.value, model: modelR.status === 'fulfilled' ? modelR.value : null };
}

/** Fast read first; the CLI only when the agent is on an older layout. Throws when both fail. */
export async function readAgentState(container: string): Promise<AgentState> {
  return (await readStateFast(container)) ?? (await readStateSlow(container));
}

async function readProfilesCli(container: string): Promise<AuthProfile[]> {
  const out = await dockerExec(
    container,
    ['openclaw', 'models', 'auth', 'list', '--provider', PROVIDER_ID, '--json'],
    { timeoutMs: CLI_TIMEOUT_MS },
  );
  const profiles = parseAuthList(out);
  // `docker exec` can exit 0 on the SIGTERM sent at the deadline: an empty body is "no answer in time".
  if (!profiles) throw new Error(out.trim() ? 'unexpected format' : 'timed out with no output');
  return profiles.filter(isChatgptProfile);
}

async function readDefaultModelCat(container: string): Promise<AgentModelRef> {
  const raw = await dockerExecNoFail(container, ['cat', CONFIG_PATH], { timeoutMs: 8000 });
  if (!raw.trim()) throw new SubscriptionError(502, 'Could not read the agent configuration.');
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new SubscriptionError(502, 'The agent configuration is not valid JSON.');
  }
  const agents = (config as { agents?: { defaults?: { model?: unknown } } }).agents;
  return (agents?.defaults?.model ?? null) as AgentModelRef;
}

/** The ChatGPT sign-ins of one running agent. Throws when it cannot be read. */
export async function readProfiles(container: string): Promise<AuthProfile[]> {
  return (await readAgentState(container)).profiles;
}

/** `agents.defaults.model` of a running agent. Throws when the config cannot be read. */
export async function readDefaultModel(container: string): Promise<AgentModelRef> {
  const s = await readAgentState(container);
  if (s.model === null) throw new SubscriptionError(502, 'Could not read the agent configuration.');
  return s.model;
}

function sameModel(a: AgentModelRef, b: AgentModelRef): boolean {
  const x = normalizeModel(a);
  const y = normalizeModel(b);
  return x.primary === y.primary && x.fallbacks.join('\n') === y.fallbacks.join('\n');
}

async function writeDefaultModel(container: string, model: { primary: string | null; fallbacks: string[] }): Promise<void> {
  // A null primary is left out of the patch (the key stays as it is) rather than sent as null.
  const body = model.primary === null ? { fallbacks: model.fallbacks } : model;
  const patch = JSON.stringify({ agents: { defaults: { model: body } } });
  try {
    await dockerExecWithInput(container, ['openclaw', 'config', 'patch', '--stdin'], patch, { timeoutMs: 30_000 });
  } catch {
    throw new SubscriptionError(502, 'The agent refused the model change.');
  }
  // Read it back: a patch that merged instead of replacing the fallbacks must not pass as done.
  const after = await readDefaultModel(container);
  if (!sameModel(after, model)) throw new SubscriptionError(502, 'The model change did not apply as expected. Check the agent panel.');
}

// ---- per-agent status and models --------------------------------------------------------

interface ModelsCache {
  at: number;
  models: SubscriptionModel[];
}
const g = globalThis as unknown as {
  __rev4aSubGen?: number;
  __rev4aSubModels?: Map<string, ModelsCache>;
  __rev4aSubMutating?: Set<string>;
};
const generation = (): number => (g.__rev4aSubGen ??= 0);
const modelsCache = (): Map<string, ModelsCache> => (g.__rev4aSubModels ??= new Map());

/**
 * Drop the cached model lists: called after a connect or disconnect (a different account may
 * now be signed in). The generation counter keeps a read that started before this call from
 * writing its stale result back. Status itself is not cached: the fast read is cheap.
 */
export function invalidateSubscriptions(): void {
  g.__rev4aSubGen = generation() + 1;
  modelsCache().clear();
}

function emptyStatus(a: AgentContainer): AgentSubscription {
  return {
    agentId: a.agentId,
    name: a.displayName || a.agentId,
    container: a.container,
    running: a.running,
    connected: false,
    email: null,
    plan: null,
    expiresAt: null,
    usesSubscription: false,
    primary: null,
    fallbacks: [],
    error: null,
  };
}

async function readAgent(a: AgentContainer): Promise<AgentSubscription> {
  const out = emptyStatus(a);
  if (!a.running) return out;
  let state: AgentState;
  try {
    state = await readAgentState(a.container);
  } catch (e) {
    out.error = cliProblem(e);
    return out;
  }
  const oauth = state.profiles;
  out.connected = oauth.length > 0;
  const best = [...oauth].sort((x, y) => (y.expiresAt ?? '').localeCompare(x.expiresAt ?? ''))[0];
  out.email = best?.email ?? null;
  out.plan = best?.plan ?? null;
  out.expiresAt = best?.expiresAt ?? null;
  if (state.model !== null) {
    const m = normalizeModel(state.model);
    out.primary = m.primary;
    out.fallbacks = m.fallbacks;
    out.usesSubscription = isSubscriptionModel(m.primary);
  }
  return out;
}

/** One agent's state, read live (about 0.5 s): each row of the page and the agent panel ask for just their own. */
export async function getAgentStatus(agentId: unknown): Promise<AgentSubscription> {
  return readAgent(await findAgentContainer(agentId));
}

/** The agent list the page renders at once: docker ps and inspect only, no exec into any agent. */
export async function getProviderList(): Promise<ProviderListView[]> {
  const containers = await listAgentContainers();
  return [{
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    agents: containers.map((a) => ({ agentId: a.agentId, name: a.displayName || a.agentId, container: a.container, running: a.running })),
  }];
}

/** The models one signed-in account offers, read from one of its agents, cached per account email. */
async function readAccountModels(container: string, email: string | null): Promise<SubscriptionModel[]> {
  const key = email ?? '';
  const gen = generation();
  const hit = modelsCache().get(key);
  if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.models;
  const out = await dockerExec(
    container,
    ['openclaw', 'models', 'list', '--provider', PROVIDER_ID, '--json'],
    { timeoutMs: CLI_TIMEOUT_MS },
  );
  const models = parseModelList(out);
  if (!models) throw new Error('unreadable');
  if (generation() === gen) modelsCache().set(key, { at: Date.now(), models });
  return models;
}

/**
 * The models the connected accounts offer (one CLI read per distinct account, cached 10 min),
 * merged by model id. Finding a connected agent per account uses the fast status read.
 */
export async function getSubscriptionModels(): Promise<{ models: SubscriptionModel[]; error: string | null }> {
  const running = (await listAgentContainers()).filter((a) => a.running);
  const states = await mapWithConcurrency(running, CONCURRENCY, async (a) => {
    try {
      const s = await readAgentState(a.container);
      const best = [...s.profiles].sort((x, y) => (y.expiresAt ?? '').localeCompare(x.expiresAt ?? ''))[0];
      return best ? { container: a.container, email: best.email } : null;
    } catch {
      return null;
    }
  });
  const sources = new Map<string, string>();
  for (const s of states) if (s && !sources.has(s.email ?? '')) sources.set(s.email ?? '', s.container);
  if (sources.size === 0) return { models: [], error: null };
  let failed = false;
  const lists = await Promise.all([...sources].map(async ([email, container]) => {
    try {
      return await readAccountModels(container, email || null);
    } catch {
      failed = true;
      return [] as SubscriptionModel[];
    }
  }));
  const merged = new Map<string, SubscriptionModel>();
  for (const list of lists) for (const m of list) if (!merged.has(m.key)) merged.set(m.key, m);
  return {
    models: [...merged.values()],
    error: failed && merged.size === 0 ? 'Could not read the model list from a connected agent.' : null,
  };
}

// ---- mutations -------------------------------------------------------------------------

/** One subscription change per agent at a time: a double click must not run two CLI calls. */
export async function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const set = (g.__rev4aSubMutating ??= new Set());
  if (set.has(agentId)) throw new SubscriptionError(409, 'Another subscription change for this agent is running');
  set.add(agentId);
  try {
    return await fn();
  } finally {
    set.delete(agentId);
  }
}

async function requireRunning(agentId: unknown): Promise<AgentContainer> {
  const a = await findAgentContainer(agentId);
  if (!a.running) throw new SubscriptionError(409, 'The agent is stopped. Start it first.');
  return a;
}

/**
 * Stop using the subscription model, drop the `openai/*` fallbacks that remain, then sign the
 * agent out of every ChatGPT (OAuth) profile. An API-key `openai:` profile is left alone.
 */
export async function disconnectAgent(agentId: unknown): Promise<{ removed: number }> {
  const a = await requireRunning(agentId);
  return withAgentLock(a.agentId, async () => {
    const current = await readDefaultModel(a.container);
    let next: AgentModelRef = current;
    if (isSubscriptionModel(normalizeModel(current).primary)) {
      next = stopSubscriptionModel(current);
      if (next === current) {
        throw new SubscriptionError(409, 'This agent uses the subscription model and has no model of its own to go back to. Choose one in the agent panel first.');
      }
    }
    const n = normalizeModel(next);
    const kept = n.fallbacks.filter((f) => !isSubscriptionModel(f));
    if (next !== current || kept.length !== n.fallbacks.length) {
      await writeDefaultModel(a.container, { primary: n.primary, fallbacks: kept });
    }
    const profiles = await readProfiles(a.container).catch(() => null);
    if (!profiles) throw new SubscriptionError(502, 'Could not read the subscription status from this agent.');
    let removed = 0;
    for (const p of profiles) {
      if (!/^openai:\S+$/.test(p.id)) continue;
      try {
        await dockerExec(a.container, ['openclaw', 'models', 'auth', 'logout', p.id, '--yes'], { timeoutMs: CLI_TIMEOUT_MS });
        removed++;
      } catch {
        invalidateSubscriptions();
        throw new SubscriptionError(502, 'The agent could not sign out. Try again.');
      }
    }
    invalidateSubscriptions();
    return { removed };
  });
}

/** Counter bumped by every connect or disconnect: a cache fill that started before it is dropped. */
export function subscriptionGeneration(): number {
  return generation();
}
