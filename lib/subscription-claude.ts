/**
 * The Claude (Pro/Max) subscription of one agent, read and driven through Claude Code inside it.
 *
 * Anthropic's terms are the reason for the shape of this module: the sign-in happens in
 * Anthropic's own flow, Claude Code keeps the tokens in the agent's volume, and Rev4a never
 * collects, stores or intermediates a Claude credential. The one thing Rev4a touches is the code
 * the operator pastes: it is written once to the stdin of the running `claude auth login` process
 * and dropped. It is never stored in a job, a log, an error or a response, and no credential file
 * of Claude Code is ever read.
 *
 * Status is read with ONE `node -e` exec inside the agent (CLAUDE_STATUS_SCRIPT): it checks the
 * binary, runs `claude --version` and `claude auth status --json` (each under a 15 s timeout) and
 * reads `agents.defaults.models` and `agents.defaults.model` from `openclaw.json`, printing one
 * JSON line with whitelisted fields only. Claude Code is installed on the first Connect, with
 * Anthropic's own installer; it survives a restart and a recreate of the container.
 *
 * OpenClaw runs `anthropic/*` through Claude Code only when the agent's configuration carries
 * `agents.defaults.models['anthropic/*'].agentRuntime.id = 'claude-cli'`. Rev4a writes that rule
 * on connect and removes it on disconnect (lib/subscription-claude-parse.ts holds both patches);
 * OpenClaw's own CLI auth for this provider is offline-only and refused while the Gateway runs,
 * so it is never called. Rev4a drives Anthropic's sign-in instead.
 *
 * The login is an in-memory job (like the ChatGPT device-code login): one per agent, bounded by a
 * deadline, with a placeholder registered before the first await so two POSTs cannot start two.
 */
import { spawn, type ChildProcess } from 'child_process';
import {
  dockerExec,
  dockerExecNoFail,
  dockerExecWithInput,
  mapWithConcurrency,
} from '@/lib/docker-exec';
import { isValidAgentId } from '@/lib/container';
import { withAgentConfigLock } from '@/lib/agent-config-lock';
import { gatewayCliArgv } from '@/lib/gateway-cli';
import { resolveDockerSocket } from '@/lib/docker-socket';
import {
  SubscriptionError,
  UNSUPPORTED_AGENT_MESSAGE,
  findAgentContainer,
  invalidateSubscriptions,
  listAgentContainers,
  readAgentList,
  readDefaultModel,
  runsSupportedVersion,
  statusReadFailedMessage,
  subscriptionGeneration,
  withAgentLock,
  writeDefaultModel,
  writeMainModel,
  type AgentContainer,
  type AgentSubscription,
} from '@/lib/subscriptions';
import { OPENCLAW_RELOAD_TIMEOUT_MS } from '@/lib/credentials/native';
import { ensureLeanClaudeTools } from '@/lib/claude-lean-tools';
import { ENSURE_SANDBOX_ENV_SCRIPT, parseEnsureSandboxResult } from '@/lib/claude-sandbox-env';
import {
  CLAUDE_STATUS_SCRIPT_SRC,
  ROUTE_ON_PATCH,
  claudeLoginAfterInstall,
  claudeLoginDeadlineApplies,
  claudeLoginOnOutput,
  claudeLoginOnPrompt,
  claudeLoginSubmitState,
  claudeRouteOn,
  claudeState,
  describeClaudeFacts,
  parseClaudeLogin,
  parseClaudeStatus,
  routeRemovalPatch,
  validClaudeCode,
  type ClaudeLoginState,
  type ClaudeState,
  type ClaudeStatus,
} from '@/lib/subscription-claude-parse';
import {
  normalizeModel,
  revertSubscriptionModel,
  statusFailureReason,
  type AgentModelRef,
  type SubscriptionModel,
} from '@/lib/subscriptions-parse';

export type { ClaudeLoginState } from '@/lib/subscription-claude-parse';

/** The prefix of the models this provider runs: a bare `anthropic/<id>` is a Claude plan model. */
export const CLAUDE_MODEL_PREFIX = 'anthropic/';

const CLAUDE_BIN = '/root/.local/bin/claude';
const INSTALL_URL = 'https://claude.ai/install.sh';
const INSTALL_TIMEOUT_S = 300;
const LOGIN_TIMEOUT_S = 600;
/** A login job that has not finished this long after it started counts as expired (install + login + tail). */
const LOGIN_DEADLINE_S = INSTALL_TIMEOUT_S + LOGIN_TIMEOUT_S + 60;
const LOGOUT_TIMEOUT_S = 60;
const READ_TIMEOUT_MS = 40_000;
const CLI_TIMEOUT_MS = 25_000;
const MODELS_TTL_MS = 10 * 60_000;
const SOURCES_TTL_MS = 60_000;
const CONCURRENCY = 4;
const OUTPUT_KEEP_HEAD = 8_000;
const OUTPUT_MAX = 80_000;
const FINISHED_KEEP_MS = 30 * 60_000;

/**
 * Anthropic's own installer, run once when the binary is missing. `curl` and `timeout` exist in
 * the agent images; the binary lands in `/root/.local/bin`, which is the agent's data volume, so
 * it survives a restart and a recreate.
 */
const INSTALL_CMD = `timeout ${INSTALL_TIMEOUT_S} sh -c 'curl -fsSL ${INSTALL_URL} | bash'`;

/**
 * The sign-in, driven exactly as verified: a TTY is needed, so `script -e` runs it and returns
 * its exit code; `timeout` bounds it. The binary is called by its absolute path because a plain
 * `docker exec` does not necessarily carry `/root/.local/bin` in PATH.
 */
const LOGIN_CMD = `timeout ${LOGIN_TIMEOUT_S} script -e -qfc "${CLAUDE_BIN} auth login" /dev/null`;

/**
 * Kills whatever a cancelled or lost login left running inside the container (the image has no
 * `ps`, so processes are found through /proc). Only the Claude Code sign-in is matched, so an
 * operator's own login for another provider is spared; the script skips its own shell. The
 * search phrase is split by a quote ("claude auth "login) so that the script text, which is in the
 * command line of the `timeout ... sh -c` wrapper that runs it, never matches itself (the script
 * would kill its own parent and stop scanning). The in-container `timeout` stays the backstop, and a running installer keeps its own `timeout 300`.
 */
const KILL_CLAUDE_SCRIPT =
  'exec 2>/dev/null; for p in /proc/[0-9]*; do c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); ' +
  'case "$c" in *"claude auth "login*) [ "${p#/proc/}" != "$$" ] && kill "${p#/proc/}" 2>/dev/null;; esac; done; true';

/**
 * The one in-container read, imported from the pure module so a test can execute it against
 * fixtures. It prints ONE JSON line with only the fields Rev4a uses.
 */
export const CLAUDE_STATUS_SCRIPT = CLAUDE_STATUS_SCRIPT_SRC;

// ---- status ------------------------------------------------------------------------------

export interface ClaudeAgentSubscription extends AgentSubscription {
  claude: {
    state: ClaudeState;
    installed: boolean;
    version: string | null;
    /** Signed in with an API (Console) account: the row shows the error and offers Disconnect. */
    apiAccount?: true;
  };
}

interface ClaudeRaw {
  installed: boolean;
  version: string | null;
  status: ClaudeStatus | null;
  /** `claude auth status` could not be read (a timeout, a non-JSON answer). */
  statusError: boolean;
  /** `agents.defaults.models`, reduced to each entry's runtime id (the rest is not needed). */
  models: Record<string, unknown> | null;
  model: { primary: string | null; fallbacks: string[] } | null;
  /** The agent configuration could not be read. */
  configError: boolean;
}

const routeOnFrom = (models: Record<string, unknown> | null): boolean =>
  claudeRouteOn({ agents: { defaults: { models } } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** One status read; throws a SubscriptionError (409 on an unsupported line, 503 when it failed). */
async function readClaudeRaw(container: string): Promise<ClaudeRaw> {
  let out: string;
  try {
    out = await dockerExec(container, ['node', '-e', CLAUDE_STATUS_SCRIPT], { timeoutMs: READ_TIMEOUT_MS });
  } catch (e) {
    // A read that fails on an old line is the version refusal, not a transient failure.
    if ((await runsSupportedVersion(container)) === 'unsupported') {
      throw new SubscriptionError(409, UNSUPPORTED_AGENT_MESSAGE);
    }
    throw new SubscriptionError(503, statusReadFailedMessage(statusFailureReason(e instanceof Error ? e.message : String(e))));
  }
  if (!out.trim()) throw new SubscriptionError(503, statusReadFailedMessage('the read was cut off (timed out)'));
  const a = out.indexOf('{');
  const b = out.lastIndexOf('}');
  let parsed: unknown = null;
  if (a !== -1 && b > a) {
    try { parsed = JSON.parse(out.slice(a, b + 1)); } catch { parsed = null; }
  }
  if (!isRecord(parsed)) throw new SubscriptionError(503, statusReadFailedMessage('the agent answered in an unexpected format'));
  const status = isRecord(parsed.status) ? parseClaudeStatus(parsed.status) : null;
  const models = isRecord(parsed.models) ? parsed.models : null;
  const model = parsed.model === undefined || parsed.model === null
    ? null
    : normalizeModel(parsed.model as AgentModelRef);
  return {
    installed: parsed.installed === true,
    version: typeof parsed.version === 'string' ? parsed.version.slice(0, 200) : null,
    status,
    statusError: parsed.statusError === true,
    models,
    model,
    configError: parsed.error === 'config',
  };
}

function emptyClaudeRow(a: AgentContainer): ClaudeAgentSubscription {
  return {
    agentId: a.agentId,
    name: a.displayName || a.agentId,
    container: a.container,
    running: a.running,
    connected: false,
    email: null,
    plan: null,
    expiresAt: null,
    profileReferences: [],
    usesSubscription: false,
    primary: null,
    fallbacks: [],
    error: null,
    claude: { state: 'not-installed', installed: false, version: null },
  };
}

/** What the row says from one status read. */
function describeClaude(a: AgentContainer, raw: ClaudeRaw): ClaudeAgentSubscription {
  const out = emptyClaudeRow(a);
  const status = raw.status;
  const facts = describeClaudeFacts({
    installed: raw.installed,
    status,
    routeOn: routeOnFrom(raw.models),
    statusError: raw.statusError,
    configError: raw.configError,
    now: Date.now(),
  });
  out.claude = {
    state: facts.state,
    installed: raw.installed,
    version: raw.version,
    ...(facts.apiAccount ? { apiAccount: true as const } : {}),
  };
  out.connected = facts.state === 'connected';
  out.email = status?.email ?? null;
  out.plan = status?.plan ?? null;
  out.expiresAt = status?.expiresAt ?? null;
  if (raw.model) {
    out.primary = raw.model.primary;
    out.fallbacks = raw.model.fallbacks;
    out.usesSubscription = typeof out.primary === 'string' && out.primary.startsWith(CLAUDE_MODEL_PREFIX);
  }
  out.error = facts.error;
  return out;
}

/** One agent's Claude state, read live. Throws a SubscriptionError only for an invalid or unknown agent. */
export async function readClaudeAgent(agentId: unknown): Promise<ClaudeAgentSubscription> {
  const a = await findAgentContainer(agentId);
  const out = emptyClaudeRow(a);
  if (!a.running) return out;
  // An old line still answers the exec, so the row must refuse the same way the ChatGPT status
  // read does: a row carrying the message, never a Connect that is bound to fail.
  if ((await runsSupportedVersion(a.container)) === 'unsupported') {
    out.error = UNSUPPORTED_AGENT_MESSAGE;
    return out;
  }
  let raw: ClaudeRaw;
  try {
    raw = await readClaudeRaw(a.container);
  } catch (e) {
    out.error = e instanceof SubscriptionError ? e.message : statusReadFailedMessage('the read failed');
    return out;
  }
  return describeClaude(a, raw);
}

// ---- model list --------------------------------------------------------------------------

interface SourcesCache {
  at: number;
  gen: number;
  sources: Map<string, string>;
}
interface SharedModelsCache {
  at: number;
  models: SubscriptionModel[];
}

const g = globalThis as unknown as {
  __rev4aClaudeLogins?: Map<string, Job>;
  __rev4aClaudeSources?: SourcesCache;
  __rev4aClaudeSourcesInflight?: Promise<Map<string, string>>;
  /** The plan label per account email, from the same discovery (for the usage block). */
  __rev4aClaudePlans?: Map<string, string | null>;
  __rev4aSubModels?: Map<string, SharedModelsCache>;
};

const sharedModels = (): Map<string, SharedModelsCache> => (g.__rev4aSubModels ??= new Map());

/** `openclaw models list --provider anthropic --json` → the models the plan offers. */
function parseClaudeModels(input: string): SubscriptionModel[] | null {
  const a = input.indexOf('{');
  const b = input.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let json: unknown;
  try { json = JSON.parse(input.slice(a, b + 1)); } catch { return null; }
  if (!isRecord(json) || !Array.isArray(json.models)) return null;
  return json.models
    .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m.key === 'string' && m.available === true)
    .map((m) => ({
      key: m.key as string,
      name: typeof m.name === 'string' ? m.name : (m.key as string),
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
    }));
}

async function readClaudeModels(container: string, email: string | null): Promise<SubscriptionModel[]> {
  const key = `claude:${email ?? ''}`;
  const gen = subscriptionGeneration();
  const hit = sharedModels().get(key);
  if (hit && hit.models.length > 0 && Date.now() - hit.at < MODELS_TTL_MS) return hit.models;
  const out = await dockerExec(
    container,
    gatewayCliArgv(['models', 'list', '--provider', 'anthropic', '--json']),
    { timeoutMs: CLI_TIMEOUT_MS },
  );
  const models = parseClaudeModels(out);
  if (!models) throw new Error('unreadable');
  // An empty answer is never cached: it would hide the models for the whole TTL once they exist.
  if (models.length > 0 && subscriptionGeneration() === gen) sharedModels().set(key, { at: Date.now(), models });
  return models;
}

/** One connected agent per account email ('' when Claude Code reports none). */
async function discoverClaudeSources(): Promise<Map<string, string>> {
  const gen = subscriptionGeneration();
  const running = (await listAgentContainers()).filter((a) => a.running);
  const found = await mapWithConcurrency(running, CONCURRENCY, async (a) => {
    try {
      // No retry here: a failing agent is skipped, and retries would stall the whole list.
      const raw = await readClaudeRaw(a.container);
      const state = claudeState({ installed: raw.installed, status: raw.status, routeOn: routeOnFrom(raw.models), now: Date.now() });
      if (state !== 'connected') return null;
      return { email: raw.status?.email ?? '', container: a.container, plan: raw.status?.plan ?? null };
    } catch {
      return null;
    }
  });
  const sources = new Map<string, string>();
  for (const row of found) if (row && !sources.has(row.email)) sources.set(row.email, row.container);
  const plans = new Map<string, string | null>();
  for (const row of found) if (row && !plans.has(row.email)) plans.set(row.email, row.plan);
  g.__rev4aClaudePlans = plans;
  if (subscriptionGeneration() === gen) g.__rev4aClaudeSources = { at: Date.now(), gen, sources };
  return sources;
}

/** Cached 60 s; concurrent callers share one discovery; a connect or disconnect drops it. */
export async function findClaudeSources(): Promise<Map<string, string>> {
  const hit = g.__rev4aClaudeSources;
  if (hit && hit.gen === subscriptionGeneration() && Date.now() - hit.at < SOURCES_TTL_MS) return hit.sources;
  const pending = g.__rev4aClaudeSourcesInflight;
  if (pending) return pending;
  const p = discoverClaudeSources().finally(() => {
    if (g.__rev4aClaudeSourcesInflight === p) g.__rev4aClaudeSourcesInflight = undefined;
  });
  g.__rev4aClaudeSourcesInflight = p;
  return p;
}

/**
 * The models the connected Claude accounts offer: one CLI read per distinct account (cached 10
 * minutes; a connect or disconnect drops it), keeping only models Claude Code can run
 * (`available === true`). `pending` is true while a connected account still lists none.
 */
export async function getClaudeModels(): Promise<{ models: SubscriptionModel[]; error: string | null; pending: boolean }> {
  const sources = await findClaudeSources();
  if (sources.size === 0) return { models: [], error: null, pending: false };
  let failed = false;
  let pending = false;
  const lists = await Promise.all([...sources].map(async ([email, container]) => {
    try {
      const models = await readClaudeModels(container, email || null);
      if (models.length === 0) pending = true;
      return models;
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
    pending,
  };
}

// ---- login job ---------------------------------------------------------------------------

export interface ClaudeLoginView {
  agentId: string;
  state: ClaudeLoginState;
  /** Anthropic's own link, once it has printed one Rev4a may show. */
  url: string | null;
  email: string | null;
  plan: string | null;
  error: string | null;
}

interface Job extends ClaudeLoginView {
  child: ChildProcess | null;
  container: string;
  /** The raw output needed to parse the link and the prompt; emptied once a code is submitted. */
  output: string;
  /** The only output kept after submit: Anthropic's parsed failure sentence, never the echo. */
  failedText: string | null;
  startedAt: number;
  finishedAt: number | null;
  cancelled: boolean;
  /** A code was written to the process: a second one is refused. */
  codeSubmitted: boolean;
  /** Settle runs once, whatever order exit and cancel choose. */
  settled: boolean;
}

const ACTIVE: readonly ClaudeLoginState[] = ['starting', 'installing', 'waiting', 'verifying', 'connecting'];

const jobs = (): Map<string, Job> => (g.__rev4aClaudeLogins ??= new Map());

const deadlineAt = (j: Job): number => j.startedAt + LOGIN_DEADLINE_S * 1000;

function view(j: Job): ClaudeLoginView {
  return { agentId: j.agentId, state: j.state, url: j.url, email: j.email, plan: j.plan, error: j.error };
}

function finish(j: Job, state: ClaudeLoginState, error: string | null = null): void {
  if (!ACTIVE.includes(j.state)) return;
  j.state = state;
  j.error = error;
  j.finishedAt = Date.now();
  j.child = null;
  // Nothing needs the output any more, and it may hold what the terminal echoed: drop it so the
  // finished job keeps no trace of the sign-in beyond its state and the account it reached.
  j.output = '';
  j.failedText = null;
}

function prune(): void {
  const now = Date.now();
  for (const [id, j] of jobs()) {
    if (j.finishedAt && now - j.finishedAt > FINISHED_KEEP_MS && !ACTIVE.includes(j.state)) jobs().delete(id);
  }
}

/** Whether a Claude login for this agent is in progress (read by lib/agent-busy.ts). */
export function isClaudeLoginActive(agentId: string): boolean {
  const j = jobs().get(agentId);
  if (!j) return false;
  if (expireIfOverdue(j)) return false;
  return ACTIVE.includes(j.state);
}

/**
 * The same check, registered on `globalThis` for lib/agent-busy.ts. That module asks about every
 * long operation synchronously and must stay free of this module's Docker and job machinery, and a
 * static import there would also make the two modules load each other; the jobs themselves already
 * live on globalThis, so a single function is enough. Next bundles each route separately: every
 * copy of this module registers the same check on the same map, so whichever copy answers sees
 * the job the other one started.
 */
(globalThis as unknown as { __rev4aClaudeLoginActive?: (agentId: string) => boolean }).__rev4aClaudeLoginActive = isClaudeLoginActive;

/**
 * A job past its deadline is finished as expired (and its process killed, best effort). True when
 * it was. Only `starting`, `installing` and `waiting` are bounded by the deadline: `verifying`
 * and `connecting` are bounded by their own operation timeouts, so an accepted code cannot be
 * reported as expired while the route is still being written.
 */
function expireIfOverdue(j: Job): boolean {
  if (!claudeLoginDeadlineApplies(j.state) || Date.now() <= deadlineAt(j)) return false;
  void cancelClaudeLogin(j.agentId, 'expired').catch(() => { /* best effort */ });
  return true;
}

/**
 * Waits (bounded) until a Claude login of this agent has left its active states, so a disconnect
 * does not write the configuration while a sign-in is still finishing.
 */
export async function waitForClaudeLoginExit(agentId: string, maxMs = 30_000): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    if (!isClaudeLoginActive(agentId)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function onOutput(j: Job, chunk: string): void {
  // A late chunk from a process that already ended or was cancelled must not refill the buffer.
  if (!ACTIVE.includes(j.state)) return;
  const stored = claudeLoginOnOutput(j.state, { output: j.output, failed: j.failedText }, chunk);
  j.output = stored.output;
  j.failedText = stored.failed;
  // A code was written: the terminal echoes it. Only the failure sentence is kept from here on.
  if (j.state === 'verifying' || j.state === 'connecting') return;
  if (j.output.length > OUTPUT_MAX) {
    j.output = j.output.slice(0, OUTPUT_KEEP_HEAD) + j.output.slice(-(OUTPUT_MAX - OUTPUT_KEEP_HEAD));
  }
  const p = parseClaudeLogin(j.output);
  // The link stays once seen: later redraws can garble it.
  if (p.url && !j.url) j.url = p.url;
  j.state = claudeLoginOnPrompt(j.state, j.url, p.prompted);
}

/**
 * One `openclaw config patch`, then a read-back that decides. On OpenClaw 2026.10.10 a patch can
 * outlast its exec while the Gateway reloads (seen live on 2026-11-14: the Claude rule was written
 * but the exec failed; BUG-16 measured 123 s), so it gets the same 150 s as credential patches and a
 * failed exec is not a failure when the read-back shows the change.
 */
async function patchConfig(container: string, patch: object, applied: (models: ClaudeRaw['models']) => boolean): Promise<void> {
  let execFailed = false;
  try {
    await withAgentConfigLock(container, () => dockerExecWithInput(
      container,
      ['openclaw', 'config', 'patch', '--stdin'],
      JSON.stringify(patch),
      { timeoutMs: OPENCLAW_RELOAD_TIMEOUT_MS },
    ));
  } catch {
    execFailed = true;
  }
  const after = await readClaudeRaw(container);
  if (!after.configError && applied(after.models)) return;
  throw new SubscriptionError(502, execFailed
    ? 'The agent is still applying the change or refused it. Check again in a minute.'
    : 'The model change did not apply as expected. Check the agent panel.');
}

/** Switch every `anthropic/*` model of the agent to Claude Code and read the rule back. */
async function writeRouteOn(container: string): Promise<void> {
  await patchConfig(container, ROUTE_ON_PATCH, (models) => routeOnFrom(models));
}

/**
 * BUG-22: manual compaction runs Claude Code as root with bypassPermissions, which it refuses unless
 * IS_SANDBOX=1 is set; the agent's own Claude Code settings carry it (lib/claude-sandbox-env.js).
 * Not fatal: the connection works without it (only manual compaction does not), and the daemon
 * repeats the step for every connected agent.
 */
async function ensureSandboxEnvInAgent(container: string): Promise<void> {
  let result: ReturnType<typeof parseEnsureSandboxResult> = null;
  try {
    const out = await dockerExec(container, ['node', '-e', ENSURE_SANDBOX_ENV_SCRIPT], { timeoutMs: 15_000 });
    result = parseEnsureSandboxResult(out);
  } catch {
    // reported below
  }
  if (result !== 'ok' && result !== 'set') {
    console.warn(`[claude] could not set IS_SANDBOX=1 in ${container}'s Claude Code settings: ${result ?? 'exec failed'}`);
  }
}

async function run(j: Job): Promise<void> {
  if (!resolveDockerSocket()) {
    finish(j, 'failed', 'Docker is not available');
    return;
  }

  let raw: ClaudeRaw;
  try {
    raw = await readClaudeRaw(j.container);
  } catch (e) {
    finish(j, 'failed', e instanceof SubscriptionError ? e.message : 'Could not read the agent.');
    return;
  }
  if (j.cancelled || !ACTIVE.includes(j.state)) return;

  if (!raw.installed) {
    j.state = 'installing';
    try {
      await dockerExec(j.container, ['sh', '-c', INSTALL_CMD], { timeoutMs: (INSTALL_TIMEOUT_S + 20) * 1000 });
    } catch {
      finish(j, 'failed', 'Could not install Claude Code in the agent.');
      return;
    }
    if (j.cancelled || !ACTIVE.includes(j.state)) return;
    try {
      const version = await dockerExec(j.container, [CLAUDE_BIN, '--version'], { timeoutMs: 20_000 });
      if (!version.trim()) throw new Error('empty');
    } catch {
      finish(j, 'failed', 'Could not install Claude Code in the agent.');
      return;
    }
    if (j.cancelled || !ACTIVE.includes(j.state)) return;
  }

  // The install (if any) is done: the job signs in from `starting`, so the link and the prompt
  // can move it to `waiting` and a submitted code is accepted.
  j.state = claudeLoginAfterInstall(j.state);
  if (j.cancelled || !ACTIVE.includes(j.state)) return;

  // A login process left by a lost job (dashboard restart) must not linger beside the new one.
  await dockerExecNoFail(j.container, ['sh', '-c', KILL_CLAUDE_SCRIPT], { timeoutMs: 5000 });
  if (j.cancelled || !ACTIVE.includes(j.state)) return;

  const child = spawn('docker', ['exec', '-i', j.container, 'sh', '-c', LOGIN_CMD], { stdio: ['pipe', 'pipe', 'pipe'] });
  j.child = child;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => onOutput(j, c));
  child.stderr?.on('data', (c: string) => onOutput(j, c));
  child.stdin?.on('error', () => { /* the close handler reports the real outcome */ });
  child.on('error', () => finish(j, 'failed', 'Could not start the login in the agent.'));
  child.on('close', (code) => { void settle(j, code); });
}

/**
 * After Claude Code exits with 0: read the status, and only when it says a Claude plan is signed
 * in (`authMethod` `claude.ai`) switch the agent's models to Claude Code and report connected.
 */
async function verifyAndConnect(j: Job): Promise<void> {
  if (j.cancelled) { finish(j, 'cancelled'); return; }
  let raw: ClaudeRaw;
  try {
    raw = await readClaudeRaw(j.container);
  } catch {
    finish(j, 'failed', 'The sign-in may have succeeded but the agent could not be read. Reload to check.');
    return;
  }
  if (j.cancelled) { finish(j, 'cancelled'); return; }
  if (!raw.installed) {
    finish(j, 'failed', 'Claude Code is not installed in the agent.');
    return;
  }
  if (!raw.status || !raw.status.loggedIn) {
    finish(j, 'failed', 'Claude Code did not confirm the sign-in. Start again for a new code.');
    return;
  }
  if (raw.status.authMethod !== 'claude.ai') {
    finish(j, 'failed', 'Claude Code is signed in with an API account, not a Claude plan.');
    return;
  }
  j.email = raw.status.email;
  j.plan = raw.status.plan;
  j.state = 'connecting';
  j.output = '';
  try {
    await writeRouteOn(j.container);
  } catch (e) {
    finish(j, 'failed', e instanceof SubscriptionError ? e.message : 'The model change did not apply.');
    return;
  }
  await ensureSandboxEnvInAgent(j.container);
  // FEAT-27.1: Claude runs start lean. Not fatal: the connection reports connected either way.
  await ensureLeanClaudeTools(j.container);
  if (j.cancelled) { finish(j, 'cancelled'); return; }
  dropClaudeCaches();
  finish(j, 'connected');
}

async function settle(j: Job, code: number | null): Promise<void> {
  if (j.settled) return;
  j.settled = true;
  if (!ACTIVE.includes(j.state)) return;
  if (j.cancelled) { finish(j, 'cancelled'); return; }
  // `timeout` ended the sign-in after its limit.
  if (code === 124) {
    finish(j, 'expired', 'The code expired before it was entered. Start again for a new one.');
    return;
  }
  if (code === 0) {
    await verifyAndConnect(j);
    return;
  }
  const p = parseClaudeLogin(j.output);
  const failed = j.failedText ?? p.failed;
  if (failed) { finish(j, 'failed', failed); return; }
  finish(j, 'failed', 'The login ended without a result. Start again for a new code.');
}

/**
 * Start a Claude login, or return the one already running for this agent. Throws a
 * SubscriptionError with the status the route should answer.
 *
 * A placeholder job is registered before the first await, so two POSTs cannot both start; it is
 * removed again when the start fails before anything was spawned.
 */
export async function startClaudeLogin(agentId: unknown): Promise<ClaudeLoginView> {
  if (typeof agentId !== 'string' || !isValidAgentId(agentId)) throw new SubscriptionError(400, 'Invalid agent id');
  const running = jobs().get(agentId);
  if (running) expireIfOverdue(running);
  if (running && ACTIVE.includes(running.state)) return view(running);

  prune();
  const j: Job = {
    agentId, state: 'starting', url: null, email: null, plan: null, error: null,
    child: null, container: '', output: '', failedText: null, startedAt: Date.now(), finishedAt: null, cancelled: false, codeSubmitted: false, settled: false,
  };
  jobs().set(agentId, j);
  let started = false;
  try {
    // The per-agent lock is held only while the login starts (the checks and the spawn), not for
    // its whole run: while it runs, agent-busy keeps a disconnect, a recreate or an update out.
    await withAgentLock(agentId, async () => {
      const a = await findAgentContainer(agentId, { fresh: true });
      if (!a.running) throw new SubscriptionError(409, 'The agent is stopped. Start it first.');

      // Lazy: lib/agent-busy.ts imports this module for isClaudeLoginActive.
      const { agentBusyReason } = await import('@/lib/agent-busy');
      // The placeholder itself is "a login running": look only at the other operations.
      const busy = await agentBusyReason(a.agentId, { ignoreLogin: 'anthropic' });
      if (busy) throw new SubscriptionError(409, busy);
      // The ChatGPT login is not this card's own job: a busy agent means neither starts.
      const { isLoginActive } = await import('@/lib/subscription-login');
      if (isLoginActive(a.agentId)) throw new SubscriptionError(409, 'A subscription login for this agent is running');

      if ((await runsSupportedVersion(a.container)) === 'unsupported') {
        throw new SubscriptionError(409, UNSUPPORTED_AGENT_MESSAGE);
      }
      let raw: ClaudeRaw;
      try {
        raw = await readClaudeRaw(a.container);
      } catch (e) {
        throw e instanceof SubscriptionError ? e : new SubscriptionError(503, statusReadFailedMessage('the read failed'));
      }
      const state = claudeState({ installed: raw.installed, status: raw.status, routeOn: routeOnFrom(raw.models), now: Date.now() });
      if (state === 'connected') throw new SubscriptionError(409, 'This agent is already connected. Disconnect it first to use another account.');

      if (j.cancelled || !ACTIVE.includes(j.state)) return;
      j.container = a.container;
      started = true;
      void run(j).catch(() => finish(j, 'failed', 'The login could not be started.'));
    });
  } catch (e) {
    if (!started && jobs().get(agentId) === j) jobs().delete(agentId);
    throw e;
  }
  return view(j);
}

export function getClaudeLogin(agentId: string): ClaudeLoginView | null {
  const j = jobs().get(agentId);
  if (!j) return null;
  expireIfOverdue(j);
  return view(j);
}

/**
 * Hand the code to the running `claude auth login` process, once, and from a local variable only:
 * it is written to stdin and never copied into the job, a log or a response.
 */
export async function submitClaudeCode(agentId: unknown, code: unknown): Promise<ClaudeLoginView> {
  if (typeof agentId !== 'string' || !isValidAgentId(agentId)) throw new SubscriptionError(400, 'Invalid agent id');
  const j = jobs().get(agentId);
  if (!j) throw new SubscriptionError(409, 'No login is waiting for a code');
  const next = claudeLoginSubmitState(j.state, j.codeSubmitted);
  if (!next) {
    if (j.state !== 'waiting') throw new SubscriptionError(409, 'This login is not waiting for a code');
    throw new SubscriptionError(409, 'A code has already been submitted for this login');
  }
  const value = validClaudeCode(code);
  if (!value) throw new SubscriptionError(400, 'Invalid code');
  const child = j.child;
  if (!child || !child.stdin || child.stdin.destroyed) {
    finish(j, 'failed', 'The login ended before the code was submitted. Start again for a new code.');
    throw new SubscriptionError(409, 'The login ended before the code was submitted. Start again for a new code.');
  }
  j.codeSubmitted = true;
  j.state = next;
  // The output so far only held the link and the prompt; from here the PTY echoes the code.
  j.output = '';
  child.stdin.write(`${value}\r`);
  return view(j);
}

/** Stop a login, inside the container too (`timeout` is only the backstop). */
export async function cancelClaudeLogin(
  agentId: string,
  as: 'cancelled' | 'expired' = 'cancelled',
): Promise<ClaudeLoginView | null> {
  const j = jobs().get(agentId);
  if (!j) return null;
  if (!ACTIVE.includes(j.state)) return view(j);
  // Once the code is submitted the job finishes on its own (connected or failed): a cancel now
  // would mark it cancelled while the configuration change keeps running and writes the rule.
  if (j.codeSubmitted) return view(j);
  // finish() clears the child: take it first, or the host-side `docker exec` is never killed.
  const child = j.child;
  j.cancelled = true;
  if (as === 'expired') finish(j, 'expired', 'The code expired before it was entered. Start again for a new one.');
  else finish(j, 'cancelled');
  child?.kill('SIGTERM');
  // Killing the docker client leaves the process inside; the image has no `ps`, so the sign-in
  // is found through /proc. The script is fixed text and skips its own shell.
  if (j.container) await dockerExecNoFail(j.container, ['sh', '-c', KILL_CLAUDE_SCRIPT], { timeoutMs: 5000 });
  return view(j);
}

/** Drop the cached model lists and connected-agent map of Claude (called after a connect or disconnect). */
function dropClaudeCaches(): void {
  g.__rev4aClaudeSources = undefined;
  g.__rev4aClaudeSourcesInflight = undefined;
  invalidateSubscriptions();
}

// ---- disconnect --------------------------------------------------------------------------

/** Remove `anthropic/*` from `agents.defaults.model` and from the `main` entry of `agents.list`. */
async function revertClaudeModels(container: string): Promise<void> {
  const current = await readDefaultModel(container);
  const stuck = 'This agent uses the subscription model and has no model of its own to go back to. Choose one in the agent panel first.';
  const plan = revertSubscriptionModel(current, null, CLAUDE_MODEL_PREFIX);
  if (plan.stuck) throw new SubscriptionError(409, stuck);
  // The main entry goes back to the same place when it has no own model of its own.
  const list = await readAgentList(container);
  const main = list?.find((e) => e && e.id === 'main');
  const mainPlan = main && main.model !== undefined
    ? revertSubscriptionModel(main.model as AgentModelRef, plan.primary, CLAUDE_MODEL_PREFIX)
    : null;
  if (mainPlan?.stuck) throw new SubscriptionError(409, stuck);
  if (plan.changed) await writeDefaultModel(container, { primary: plan.primary, fallbacks: plan.fallbacks });
  if (mainPlan?.changed) await writeMainModel(container, { primary: mainPlan.primary, fallbacks: mainPlan.fallbacks });
}

/** Remove the Claude Code rule, when it is there, and read it back. */
async function removeClaudeRoute(container: string): Promise<void> {
  const before = await readClaudeRaw(container);
  if (before.configError) throw new SubscriptionError(502, 'Could not read the agent configuration.');
  const patch = routeRemovalPatch({ agents: { defaults: { models: before.models } } });
  if (!patch) return;
  await patchConfig(container, patch, (models) => !routeOnFrom(models));
}

/**
 * Disconnect one agent: put it back on its own model (the `anthropic/` models are reverted in
 * `agents.defaults.model` and in the `main` entry of `agents.list`), remove the Claude Code rule,
 * run Claude Code's own `auth logout` and check the agent is logged out. The binary stays: it is
 * the runtime the agent will use again on the next connect.
 */
export async function disconnectClaudeAgent(agentId: unknown): Promise<{ removed: number }> {
  const a = await findAgentContainer(agentId, { fresh: true });
  if (!a.running) throw new SubscriptionError(409, 'The agent is stopped. Start it first.');
  return withAgentLock(a.agentId, async () => {
    let raw: ClaudeRaw;
    try {
      raw = await readClaudeRaw(a.container);
    } catch (e) {
      throw e instanceof SubscriptionError ? e : new SubscriptionError(502, 'Could not read the subscription status from this agent.');
    }
    await revertClaudeModels(a.container);
    await removeClaudeRoute(a.container);
    const wasLoggedIn = raw.status?.loggedIn === true;
    if (raw.installed) {
      // Run the sign-out whenever Claude Code is there: a status that could not be parsed must
      // not leave an account signed in. It is idempotent when already signed out.
      try {
        // `timeout` inside the container: a host-side deadline leaves the process running there.
        await dockerExec(
          a.container,
          ['timeout', String(LOGOUT_TIMEOUT_S), CLAUDE_BIN, 'auth', 'logout'],
          { timeoutMs: (LOGOUT_TIMEOUT_S + 10) * 1000 },
        );
      } catch {
        dropClaudeCaches();
        throw new SubscriptionError(502, 'The agent could not sign out. Try again.');
      }
    }
    dropClaudeCaches();
    // A sign-out that timed out answers with no error: read the status back.
    const after = await readClaudeRaw(a.container).catch(() => null);
    if (!after) throw new SubscriptionError(502, 'Could not read the subscription status from this agent.');
    if (after.status?.loggedIn) throw new SubscriptionError(502, 'The sign-out did not complete. Try again.');
    return { removed: wasLoggedIn ? 1 : 0 };
  });
}

/** The plan label of a connected Claude account, from the last discovery; null when unknown. */
export function claudePlanFor(email: string): string | null {
  return g.__rev4aClaudePlans?.get(email) ?? null;
}
