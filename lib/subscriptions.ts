/**
 * Subscriptions: which agents are signed in to a ChatGPT (Codex) account, and which of
 * them use a subscription model as their primary.
 *
 * The OAuth profile lives in the agent's own volume (`~/.openclaw/state/openclaw.sqlite`).
 * Status is read with ONE `docker exec node -e` inside the agent (STATUS_SCRIPT, about
 * 0.5 s): it prints the profile ids, emails, plan and expiry and the agent's model, never a
 * token. An `openclaw` CLI call boots every plugin (about 7 s), so the CLI is only the way to
 * list models, disconnect and write the model:
 *
 *   models list --provider openai --json     the models the account offers (cached 10 min)
 *   models auth logout <profile> --yes       disconnect
 *   config patch --stdin                     `agents.defaults.model` only
 *
 * The model is read first (fast read), written, and read back; a config that cannot be read
 * is never written over. Per-agent status is not cached: every row of the page reads its own agent.
 * The container list is cached 5 s (N parallel row reads share one `docker ps`) and the
 * email -> container map used to find a source agent per account 60 s.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dockerExec, dockerExecNoFail, dockerExecWithInput, mapWithConcurrency } from '@/lib/docker-exec';
import { isValidAgentId } from '@/lib/container';
import { withAgentConfigLock } from '@/lib/agent-config-lock';
import { gatewayCliArgv } from '@/lib/gateway-cli';
import { SUPPORTED_VERSIONS, parseOpenClawVersion } from '@/lib/agent-versions';
import { listLocalAgentImages } from '@/lib/agent-images';
import { dockerRequestJson } from '@/lib/docker-socket-path';
import {
  parseModelList,
  parseStatusJson,
  isSupportedLine,
  statusFailureReason,
  readWithRetry,
  STATUS_SCRIPT_SRC,
  STOP_CODEX_SCRIPT,
  revertSubscriptionModel,
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
const CONTAINERS_TTL_MS = 5_000;
const SOURCES_TTL_MS = 60_000;
const LOGOUT_TIMEOUT_S = 60;

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

interface ContainersCache {
  at: number;
  rows: AgentContainer[];
}
const cg = globalThis as unknown as {
  __rev4aSubContainers?: ContainersCache;
  __rev4aSubContainersInflight?: Promise<AgentContainer[]>;
};

/**
 * Every agent container, through one `docker ps` and one `docker inspect`. A running container
 * wins over a stopped twin. Cached for 5 s, and concurrent callers share one read, so the N
 * parallel row reads of the page do not run N pairs. `fresh` skips the cache (a mutation about
 * to act on the container).
 */
export async function listAgentContainers(opts: { fresh?: boolean } = {}): Promise<AgentContainer[]> {
  const hit = cg.__rev4aSubContainers;
  if (!opts.fresh && hit && Date.now() - hit.at < CONTAINERS_TTL_MS) return hit.rows;
  if (!opts.fresh && cg.__rev4aSubContainersInflight) return cg.__rev4aSubContainersInflight;
  const p = readAgentContainers()
    .then((rows) => {
      cg.__rev4aSubContainers = { at: Date.now(), rows };
      return rows;
    })
    .finally(() => { if (cg.__rev4aSubContainersInflight === p) cg.__rev4aSubContainersInflight = undefined; });
  if (!opts.fresh) cg.__rev4aSubContainersInflight = p;
  return p;
}

async function readAgentContainers(): Promise<AgentContainer[]> {
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

export async function findAgentContainer(agentId: unknown, opts: { fresh?: boolean } = {}): Promise<AgentContainer> {
  if (typeof agentId !== 'string' || !isValidAgentId(agentId)) throw new SubscriptionError(400, 'Invalid agent id');
  const found = (await listAgentContainers(opts)).find((a) => a.agentId === agentId);
  if (!found) throw new SubscriptionError(404, `No container found with AGENT_ID '${agentId}'`);
  return found;
}

/** The supported majors, as "2026.9.x", from lib/agent-versions.json: a version added there updates the message. */
const supportedMajors = [...new Set(SUPPORTED_VERSIONS.map((v) => v.version.split('.').slice(0, 2).join('.') + '.x'))].join(' or ');

/** The one refusal for an agent whose state is not where a supported version keeps it (HTTP 409 wherever it is raised). */
export const UNSUPPORTED_AGENT_MESSAGE = `This agent is not on a supported OpenClaw version (${supportedMajors}). Update it first.`;

/** The message a failed fast read carries (HTTP 503 wherever it is raised). */
export const statusReadFailedMessage = (reason: string): string => `Could not read this agent's subscription status: ${reason}`;

// ---- fast status read -------------------------------------------------------------------

/**
 * Runs inside the agent container with `node -e` (argv form: a fixed constant, nothing is
 * interpolated). It opens the agent's state database read-only, reads the auth profile store
 * and `agents.defaults.model`, and prints ONE JSON line with only the fields the page needs.
 * `access`, `refresh` and `accountId` are never copied: the tokens do not leave the container.
 * It takes about 0.5 s; an `openclaw` CLI call boots every plugin and takes about 7 s.
 *
 * `{"unsupported":true}` means this agent does not keep its state where 2026.9.x does (no
 * node:sqlite, no state database, no profile table). Any other failure exits non-zero. A missing
 * profile row is simply no profiles. A config that cannot be read gives `model: null` and `error`.
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

/** The fast read's answer: the state, "not a supported OpenClaw version", or "could not read" with the reason. */
export type FastRead = { status: 'ok'; state: AgentState } | { status: 'unsupported' } | { status: 'failed'; reason: string };

const READ_TIMEOUT_MS = 12_000;
/** Pauses before the 2nd and 3rd attempt of a failed read. */
const RETRY_DELAYS_MS = [1_000, 2_000];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every Docker call of the version check gives up after this: the check must never hold a row. */
const VERSION_CHECK_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Whether the container's image is on a supported OpenClaw line (major.minor: any 2026.9.x build
 * is the 2026.9 line). 'unknown' when the version cannot be told, which includes a Docker that
 * does not answer in time: the slow `openclaw --version` exec fallback is not used here.
 */
async function runsSupportedVersion(container: string): Promise<'supported' | 'unsupported' | 'unknown'> {
  try {
    const info = await dockerRequestJson<{ Image?: string }>('GET', `/containers/${encodeURIComponent(container)}/json`, VERSION_CHECK_TIMEOUT_MS);
    if (!info?.Image) return 'unknown';
    const images = await withTimeout(listLocalAgentImages(), VERSION_CHECK_TIMEOUT_MS, 'Docker image list');
    let version = images.find((img) => img.id === info.Image)?.version ?? null;
    if (!version) {
      // An image that lost its tags still carries its version label.
      const image = await dockerRequestJson<{ Config?: { Labels?: Record<string, string> | null } | null }>(
        'GET', `/images/${encodeURIComponent(info.Image)}/json`, VERSION_CHECK_TIMEOUT_MS,
      );
      version = parseOpenClawVersion(image?.Config?.Labels?.['org.opencontainers.image.version']);
    }
    if (!version) return 'unknown';
    return isSupportedLine(version, SUPPORTED_VERSIONS.map((v) => v.version)) ? 'supported' : 'unsupported';
  } catch {
    return 'unknown';
  }
}

async function readStatusOnce(container: string): Promise<FastRead> {
  let out: string;
  try {
    out = await dockerExec(container, ['node', '-e', STATUS_SCRIPT], { timeoutMs: READ_TIMEOUT_MS });
  } catch (e) {
    return { status: 'failed', reason: statusFailureReason(e instanceof Error ? e.message : String(e)) };
  }
  // `docker exec` can exit 0 on the SIGTERM sent at the deadline: empty output is a cut-off read.
  if (!out.trim()) return { status: 'failed', reason: 'the read was cut off (timed out)' };
  const s = parseStatusJson(out);
  if (!s) return { status: 'failed', reason: 'the agent answered in an unexpected format' };
  if (s.unsupported) {
    // The status script can only see that the state database is not where 2026.9.x keeps it.
    // A supported agent shows the same thing before its Gateway has created that database
    // (just created or recreated): the image's version tells the two apart.
    // A version that cannot be told is also "still starting" (retryable), never "unsupported".
    return (await runsSupportedVersion(container)) === 'unsupported'
      ? { status: 'unsupported' }
      : { status: 'failed', reason: 'the agent is still starting' };
  }
  return { status: 'ok', state: { profiles: s.profiles.filter(isChatgptProfile), model: s.error ? null : s.model } };
}

/**
 * The status read (about 0.5 s). A failed read is retried up to twice (after 1 s, then 2 s),
 * never an 'ok' or 'unsupported' answer; a timeout is retried once at most and a stopped
 * container not at all. Worst case: two timed-out reads plus a fast failure with both pauses,
 * about 27 s; a failure that is not a timeout costs at most 3 s of pauses. `retry: false` reads once.
 */
export async function readFastStatus(container: string, opts: { retry?: boolean } = {}): Promise<FastRead> {
  return readWithRetry(() => readStatusOnce(container), opts.retry === false ? [] : RETRY_DELAYS_MS, sleep);
}

/** The agent's state. Throws a SubscriptionError: 409 when the agent is not on a supported version, 503 when the read failed. */
export async function readAgentState(container: string, opts: { retry?: boolean } = {}): Promise<AgentState> {
  const r = await readFastStatus(container, opts);
  if (r.status === 'ok') return r.state;
  if (r.status === 'unsupported') throw new SubscriptionError(409, UNSUPPORTED_AGENT_MESSAGE);
  throw new SubscriptionError(503, statusReadFailedMessage(r.reason));
}

/** The ChatGPT sign-ins of one running agent. Throws when it cannot be read. */
export async function readProfiles(container: string, opts: { retry?: boolean } = {}): Promise<AuthProfile[]> {
  return (await readAgentState(container, opts)).profiles;
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
    await withAgentConfigLock(container, () => dockerExecWithInput(container, ['openclaw', 'config', 'patch', '--stdin'], patch, { timeoutMs: 30_000 }));
  } catch {
    throw new SubscriptionError(502, 'The agent refused the model change.');
  }
  // Read it back: a patch that merged instead of replacing the fallbacks must not pass as done.
  const after = await readDefaultModel(container);
  if (!sameModel(after, model)) throw new SubscriptionError(502, 'The model change did not apply as expected. Check the agent panel.');
}

// ---- per-agent status and models --------------------------------------------------------

export interface SourceAgent {
  container: string;
  name: string;
}
interface SourcesCache {
  at: number;
  gen: number;
  sources: Map<string, SourceAgent>;
}

interface ModelsCache {
  at: number;
  models: SubscriptionModel[];
}
const g = globalThis as unknown as {
  __rev4aSubGen?: number;
  __rev4aSubModels?: Map<string, ModelsCache>;
  __rev4aSubMutating?: Set<string>;
  __rev4aSubSources?: SourcesCache;
  __rev4aSubSourcesInflight?: Promise<Map<string, SourceAgent>>;
};
const generation = (): number => (g.__rev4aSubGen ??= 0);
const modelsCache = (): Map<string, ModelsCache> => (g.__rev4aSubModels ??= new Map());

/**
 * Drop the cached model lists and the email -> container map: called after a connect or
 * disconnect (a different account may now be signed in). The generation counter keeps a read
 * that started before this call from writing its stale result back. Status itself is not
 * cached: the fast read is cheap. The usage cache (lib/subscription-usage.ts) is NOT dropped:
 * the quota belongs to the account, which a connect or disconnect does not change; a result
 * read before this call is merely not stored (it uses the same counter).
 */
export function invalidateSubscriptions(): void {
  g.__rev4aSubGen = generation() + 1;
  modelsCache().clear();
  g.__rev4aSubSources = undefined;
  g.__rev4aSubSourcesInflight = undefined;
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
    out.error = e instanceof SubscriptionError ? e.message : statusReadFailedMessage('the read failed');
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
    // Reaches the Gateway: the token must be the one it runs with (see lib/gateway-cli.ts).
    gatewayCliArgv(['models', 'list', '--provider', PROVIDER_ID, '--json']),
    { timeoutMs: CLI_TIMEOUT_MS },
  );
  const models = parseModelList(out);
  if (!models) throw new Error('unreadable');
  if (generation() === gen) modelsCache().set(key, { at: Date.now(), models });
  return models;
}

async function discoverSources(): Promise<Map<string, SourceAgent>> {
  const gen = generation();
  const running = (await listAgentContainers()).filter((a) => a.running);
  const found = await mapWithConcurrency(running, CONCURRENCY, async (a) => {
    // One read per agent: a failing agent is skipped here anyway, and retries would stall the models and usage reads.
    const r = await readFastStatus(a.container, { retry: false });
    if (r.status !== 'ok') return [];
    return r.state.profiles.map((p) => ({ email: p.email ?? '', container: a.container, name: a.displayName || a.agentId }));
  });
  const sources = new Map<string, SourceAgent>();
  for (const list of found) {
    for (const s of list) if (!sources.has(s.email)) sources.set(s.email, { container: s.container, name: s.name });
  }
  if (generation() === gen) {
    g.__rev4aSubSources = { at: Date.now(), gen, sources };
  }
  return sources;
}

/**
 * One running connected agent per account email ('' for a profile without an email), from the
 * fast status read. Cached 60 s; a connect or disconnect drops it, and a read that started
 * before that is not stored. Concurrent callers share one discovery.
 */
export async function findAccountSources(): Promise<Map<string, SourceAgent>> {
  const hit = g.__rev4aSubSources;
  if (hit && hit.gen === generation() && Date.now() - hit.at < SOURCES_TTL_MS) return hit.sources;
  const pending = g.__rev4aSubSourcesInflight;
  if (pending) return pending;
  const p = discoverSources().finally(() => { if (g.__rev4aSubSourcesInflight === p) g.__rev4aSubSourcesInflight = undefined; });
  g.__rev4aSubSourcesInflight = p;
  return p;
}

/**
 * The models the connected accounts offer (one CLI read per distinct account, cached 10 min),
 * merged by model id. Finding a connected agent per account uses the cached fast discovery.
 */
export async function getSubscriptionModels(): Promise<{ models: SubscriptionModel[]; error: string | null }> {
  const sources = await findAccountSources();
  if (sources.size === 0) return { models: [], error: null };
  let failed = false;
  const lists = await Promise.all([...sources].map(async ([email, src]) => {
    try {
      return await readAccountModels(src.container, email || null);
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
  const a = await findAgentContainer(agentId, { fresh: true });
  if (!a.running) throw new SubscriptionError(409, 'The agent is stopped. Start it first.');
  return a;
}

/** The `agents.list` of the agent's configuration, or null when it cannot be read or has none. */
async function readAgentList(container: string): Promise<Record<string, unknown>[] | null> {
  const raw = await dockerExecNoFail(container, ['cat', CONFIG_PATH], { timeoutMs: 8000 });
  if (!raw.trim()) return null;
  try {
    const list = (JSON.parse(raw) as { agents?: { list?: unknown } }).agents?.list;
    return Array.isArray(list) ? (list as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

/**
 * Put `model` on the `id: main` entry of `agents.list`. The patch carries the whole list (an
 * array is replaced as a whole), read just before, with only that entry's model changed.
 */
async function writeMainModel(container: string, model: { primary: string | null; fallbacks: string[] }): Promise<void> {
  // The list is read, changed and sent back whole: hold the agent's config lock across all three,
  // or a patch landing in between would be overwritten by the stale list.
  await withAgentConfigLock(container, async () => {
    const list = await readAgentList(container);
    const main = list?.find((e) => e && e.id === 'main');
    if (!list || !main) throw new SubscriptionError(502, 'Could not read the agent configuration.');
    // Like writeDefaultModel: a null primary is left out (an entry with only fallbacks keeps that
    // shape) instead of being written as an explicit null.
    const entryModel = model.primary === null ? { fallbacks: model.fallbacks } : { primary: model.primary, fallbacks: model.fallbacks };
    const next = list.map((e) => (e === main ? { ...e, model: entryModel } : e));
    try {
      await dockerExecWithInput(container, ['openclaw', 'config', 'patch', '--stdin'], JSON.stringify({ agents: { list: next } }), { timeoutMs: 30_000 });
    } catch {
      throw new SubscriptionError(502, 'The agent refused the model change.');
    }
  });
  const after = (await readAgentList(container))?.find((e) => e && e.id === 'main');
  if (!after || !sameModel(after.model as AgentModelRef, model)) {
    throw new SubscriptionError(502, 'The model change did not apply as expected. Check the agent panel.');
  }
}

/**
 * Stop using the subscription model (in `agents.defaults.model` and in the `main` entry of
 * `agents.list`, which the model panel writes too), drop the `openai/*` fallbacks that remain,
 * then sign the agent out of every ChatGPT (OAuth) profile and check the profiles are gone.
 * An API-key `openai:` profile is left alone.
 */
export async function disconnectAgent(agentId: unknown): Promise<{ removed: number }> {
  const a = await requireRunning(agentId);
  return withAgentLock(a.agentId, async () => {
    const current = await readDefaultModel(a.container);
    const stuck = 'This agent uses the subscription model and has no model of its own to go back to. Choose one in the agent panel first.';
    const plan = revertSubscriptionModel(current, null);
    if (plan.stuck) throw new SubscriptionError(409, stuck);
    // The main entry goes back to the same place when it has no own model of its own.
    const list = await readAgentList(a.container);
    const main = list?.find((e) => e && e.id === 'main');
    const mainPlan = main && main.model !== undefined ? revertSubscriptionModel(main.model as AgentModelRef, plan.primary) : null;
    if (mainPlan?.stuck) throw new SubscriptionError(409, stuck);
    if (plan.changed) {
      await writeDefaultModel(a.container, { primary: plan.primary, fallbacks: plan.fallbacks });
    }
    if (mainPlan?.changed) {
      await writeMainModel(a.container, { primary: mainPlan.primary, fallbacks: mainPlan.fallbacks });
    }
    const profiles = await readProfiles(a.container).catch(() => null);
    if (!profiles) throw new SubscriptionError(502, 'Could not read the subscription status from this agent.');
    let removed = 0;
    for (const p of profiles) {
      if (!/^openai:\S+$/.test(p.id)) continue;
      try {
        // `timeout` inside the container: a host-side deadline leaves the process running there.
        await dockerExec(a.container, ['timeout', String(LOGOUT_TIMEOUT_S), 'openclaw', 'models', 'auth', 'logout', p.id, '--yes'], { timeoutMs: (LOGOUT_TIMEOUT_S + 10) * 1000 });
        removed++;
      } catch {
        invalidateSubscriptions();
        throw new SubscriptionError(502, 'The agent could not sign out. Try again.');
      }
    }
    invalidateSubscriptions();
    // A sign-out that timed out answers with no error: read the profiles back.
    const after = await readAgentState(a.container).catch(() => null);
    if (!after) throw new SubscriptionError(502, 'Could not read the subscription status from this agent.');
    if (after.profiles.length > 0) throw new SubscriptionError(502, 'The sign-out did not complete. Try again.');
    // The gateway keeps the Codex runtime (one app-server per session that used the subscription)
    // running after the sign-out: stop it. Best effort: a failure here leaves a signed-out agent.
    if (removed > 0) {
      await dockerExec(a.container, ['sh', '-c', STOP_CODEX_SCRIPT], { timeoutMs: 10_000 }).catch(() => undefined);
    }
    return { removed };
  });
}

/** Counter bumped by every connect or disconnect: a cache fill that started before it is dropped. */
export function subscriptionGeneration(): number {
  return generation();
}
