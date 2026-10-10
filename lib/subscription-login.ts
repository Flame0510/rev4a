/**
 * The ChatGPT (Codex) device-code login of one agent, run as an in-memory job.
 *
 * `openclaw models auth login --provider openai --device-code` needs a TTY, so it runs
 * under `script` inside the container (`docker exec` without `-t`), bounded by `timeout`.
 * Its output is ANSI-decorated, redrawn by a spinner, and can arrive one character per
 * line; lib/subscriptions-parse.js turns it into a link, a code and an outcome.
 *
 * One job per agent. A dashboard restart loses the job (the operator starts again); the
 * in-container `timeout` bounds the orphaned process. A job that has not finished
 * `LOGIN_DEADLINE_S` seconds after it started (readiness wait + the login's own limit + a
 * tail) counts as expired, so a paused container or a hung `docker exec` cannot keep the agent
 * busy forever. The OpenAI link and code are shown
 * to the operator and never logged.
 */
import { spawn, type ChildProcess } from 'child_process';
import { waitForGatewayReady } from '@/lib/agent-readiness';
import { dockerExecNoFail } from '@/lib/docker-exec';
import { resolveDockerSocket } from '@/lib/docker-socket';
import { loginDeadlineAt, parseDeviceLogin } from '@/lib/subscriptions-parse';
import { isValidAgentId } from '@/lib/container';
import { SubscriptionError, UNSUPPORTED_AGENT_MESSAGE, findAgentContainer, invalidateSubscriptions, readFastStatus, readProfiles, statusReadFailedMessage, withAgentLock } from '@/lib/subscriptions';

export type LoginState = 'starting' | 'waiting' | 'connected' | 'failed' | 'expired' | 'cancelled';

export interface LoginView {
  agentId: string;
  state: LoginState;
  url: string | null;
  code: string | null;
  /** Epoch ms at which the code stops working. */
  expiresAt: number | null;
  email: string | null;
  error: string | null;
}

interface Job extends LoginView {
  child: ChildProcess | null;
  container: string;
  output: string;
  startedAt: number;
  finishedAt: number | null;
  cancelled: boolean;
  /** Set once the early confirmation (on OpenAI's "complete") has started, so it runs once. */
  confirming: boolean;
  /** The login process has exited (it can outlive an early "connected" by a few seconds). */
  exited: boolean;
}

const LOGIN_TIMEOUT_S = 900;
const READY_TIMEOUT_MS = 60_000;
const OUTPUT_KEEP_HEAD = 8_000;
const OUTPUT_MAX = 80_000;
const FINISHED_KEEP_MS = 30 * 60_000;

// `script -e` returns the child's exit code: util-linux 2.38 `script` exits 0 whatever the child did.
const LOGIN_CMD = `timeout ${LOGIN_TIMEOUT_S} script -e -qfc "openclaw models auth login --provider openai --device-code" /dev/null`;

/**
 * Kills every process whose command line holds this login (no pkill in the agent image). Only the
 * device-code login of the openai provider matches: an operator's own login for another provider
 * is spared.
 */
const KILL_LOGIN_SCRIPT =
  'exec 2>/dev/null; for p in /proc/[0-9]*; do c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); ' +
  'case "$c" in *"models auth login --provider openai --device-code"*) [ "${p#/proc/}" != "$$" ] && kill "${p#/proc/}" 2>/dev/null;; esac; done; true';

const g = globalThis as unknown as { __rev4aSubLogins?: Map<string, Job> };
const jobs = (): Map<string, Job> => (g.__rev4aSubLogins ??= new Map());

const ACTIVE: readonly LoginState[] = ['starting', 'waiting'];

/** Whether a login for this agent is in progress (read by lib/agent-busy.ts). */
export function isLoginActive(agentId: string): boolean {
  const j = jobs().get(agentId);
  if (!j) return false;
  if (expireIfOverdue(j)) return false;
  return ACTIVE.includes(j.state) || loginFinishing(j);
}

/** A job past its deadline is finished as expired (and its process killed, best effort). True when it was. */
function expireIfOverdue(j: Job): boolean {
  if (!ACTIVE.includes(j.state) || Date.now() <= loginDeadlineAt(j.startedAt)) return false;
  void cancelLogin(j.agentId, 'expired').catch(() => { /* best effort */ });
  return true;
}

/** Connected early, but the CLI is still writing the agent's config before it exits (bounded). */
function loginFinishing(j: Job): boolean {
  return j.state === 'connected' && !j.exited && j.finishedAt !== null && Date.now() - j.finishedAt < 60_000;
}

/** True when the only thing running is the tail of a login that already connected. */
export function isLoginFinishingOnly(agentId: string): boolean {
  const j = jobs().get(agentId);
  return !!j && loginFinishing(j);
}

/** Waits (bounded) until a connected login's process has exited, so a config write does not overlap it. */
export async function waitForLoginExit(agentId: string, maxMs = 30_000): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const j = jobs().get(agentId);
    if (!j || !loginFinishing(j)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function view(j: Job): LoginView {
  return { agentId: j.agentId, state: j.state, url: j.url, code: j.code, expiresAt: j.expiresAt, email: j.email, error: j.error };
}

function finish(j: Job, state: LoginState, error: string | null = null): void {
  if (!ACTIVE.includes(j.state)) return;
  j.state = state;
  j.error = error;
  j.finishedAt = Date.now();
  j.child = null;
}

function prune(): void {
  const now = Date.now();
  for (const [id, j] of jobs()) {
    if (j.finishedAt && now - j.finishedAt > FINISHED_KEEP_MS) jobs().delete(id);
  }
}

function onOutput(j: Job, chunk: string): void {
  j.output += chunk;
  if (j.output.length > OUTPUT_MAX) {
    j.output = j.output.slice(0, OUTPUT_KEEP_HEAD) + j.output.slice(-(OUTPUT_MAX - OUTPUT_KEEP_HEAD));
  }
  const p = parseDeviceLogin(j.output);
  // The link and the code stay once seen: the spinner redraw can garble them later.
  if (p.url && !j.url) j.url = p.url;
  if (p.code && !j.code) j.code = p.code;
  if (j.url && j.code && j.state === 'starting') {
    j.state = 'waiting';
    j.expiresAt = Date.now() + (p.expiresInMin ?? 15) * 60_000;
  }
  // OpenAI accepted the code: the CLI keeps going for seconds (it rewrites the config and
  // checks the default model) before it exits. Confirm with the agent now instead of waiting.
  if (p.done === 'ok' && j.state === 'waiting' && !j.confirming) {
    j.confirming = true;
    void confirmEarly(j);
  }
}

/**
 * The profile is stored right around OpenAI's "complete" line: look for it a few times with
 * the fast read and finish as connected. If it never shows, settle() decides on exit as before.
 */
async function confirmEarly(j: Job): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if (!ACTIVE.includes(j.state) || j.cancelled) return;
    try {
      // Best effort, polled again: no retry here (settle() reads with retries if this never lands).
      const profiles = await readProfiles(j.container, { retry: false });
      if (profiles.length > 0 && ACTIVE.includes(j.state)) {
        j.email = profiles.find((x) => x.email)?.email ?? null;
        invalidateSubscriptions();
        finish(j, 'connected');
        return;
      }
    } catch { /* try again */ }
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function run(j: Job): Promise<void> {
  const ready = await waitForGatewayReady(j.container, READY_TIMEOUT_MS);
  if (j.cancelled || !ACTIVE.includes(j.state)) return;
  if (!ready) {
    finish(j, 'failed', 'The agent is not ready yet. Wait a moment and try again.');
    return;
  }
  if (!resolveDockerSocket()) {
    finish(j, 'failed', 'Docker is not available');
    return;
  }

  // A login process left by a lost job (dashboard restart) must not linger beside the new one.
  await dockerExecNoFail(j.container, ['sh', '-c', KILL_LOGIN_SCRIPT], { timeoutMs: 5000 });
  if (j.cancelled || !ACTIVE.includes(j.state)) return;

  const child = spawn('docker', ['exec', j.container, 'sh', '-c', LOGIN_CMD], { stdio: ['ignore', 'pipe', 'pipe'] });
  j.child = child;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => onOutput(j, c));
  child.stderr?.on('data', (c: string) => onOutput(j, c));
  child.on('error', () => finish(j, 'failed', 'Could not start the login in the agent.'));
  child.on('close', (code) => { j.exited = true; void settle(j, code); });
}

async function settle(j: Job, code: number | null): Promise<void> {
  if (!ACTIVE.includes(j.state)) return;
  if (j.cancelled) { finish(j, 'cancelled'); return; }
  const p = parseDeviceLogin(j.output);
  // The parsed outcome first: OpenClaw's own message beats an exit code.
  if (p.done === 'failed') { finish(j, 'failed', p.error); return; }
  // `timeout` ended the login after its limit.
  if (code === 124) {
    finish(j, 'expired', 'The code expired before it was entered. Start again for a new one.');
    return;
  }
  if (p.done === 'ok' || code === 0) {
    // Confirm with the agent itself: the profile must exist, whatever the output said.
    // The read retries a transient failure itself; if it still fails, say so instead of "no account".
    const read = await readFastStatus(j.container);
    if (read.status === 'ok') {
      const profiles = read.state.profiles;
      if (profiles.length > 0) {
        j.email = profiles.find((x) => x.email)?.email ?? null;
        invalidateSubscriptions();
        finish(j, 'connected');
        return;
      }
      finish(j, 'failed', 'OpenAI confirmed the login but the agent holds no account. Try again.');
      return;
    }
    const why = read.status === 'failed' ? read.reason : 'the agent is not on a supported OpenClaw version';
    finish(j, 'failed', `The login may have succeeded but the agent could not be read: ${why}. Reload to check.`);
    return;
  }
  if (!j.url) {
    finish(j, 'failed', 'The agent could not start the login. Wait a moment and try again.');
    return;
  }
  finish(j, 'failed', 'The login ended without a result. Start again for a new code.');
}

/**
 * Start a login, or return the one already running for this agent (a second tab or a reopened
 * dialog resumes it). Throws a SubscriptionError with the status the route should answer.
 *
 * A placeholder job is registered before the first await, so two POSTs in a row cannot both
 * start a login; it is removed again when the start fails before anything was spawned.
 */
export async function startLogin(agentId: unknown): Promise<LoginView> {
  if (typeof agentId !== 'string' || !isValidAgentId(agentId)) throw new SubscriptionError(400, 'Invalid agent id');
  const running = jobs().get(agentId);
  if (running) expireIfOverdue(running);
  if (running && ACTIVE.includes(running.state)) return view(running);
  // Connected, but the CLI is still finishing: that job is the answer, not a new login.
  // Only the bounded tail (loginFinishing): a CLI that never exits must not hide a new login forever.
  if (running && loginFinishing(running)) return view(running);

  prune();
  const j: Job = {
    agentId, state: 'starting', url: null, code: null, expiresAt: null, email: null, error: null,
    child: null, container: '', output: '', startedAt: Date.now(), finishedAt: null, cancelled: false, confirming: false, exited: false,
  };
  jobs().set(agentId, j);
  let started = false;
  try {
    // The per-agent lock of a disconnect, held only while the login starts (the checks and the spawn), not
    // for its whole run: while it runs, agent-busy keeps a disconnect, a recreate or an update out.
    await withAgentLock(agentId, async () => {
      const a = await findAgentContainer(agentId, { fresh: true });
      if (!a.running) throw new SubscriptionError(409, 'The agent is stopped. Start it first.');

      // Lazy: lib/agent-busy.ts imports this module for isLoginActive.
      const { agentBusyReason } = await import('@/lib/agent-busy');
      // The placeholder itself is "a login running": look only at the other operations.
      const busy = await agentBusyReason(a.agentId, { ignoreLogin: true });
      if (busy) throw new SubscriptionError(409, busy);

      // A failed read is never "not connected"; an agent without the 2026.9.x profile table cannot connect.
      const read = await readFastStatus(a.container);
      if (read.status === 'failed') throw new SubscriptionError(503, statusReadFailedMessage(read.reason));
      if (read.status === 'unsupported') throw new SubscriptionError(409, UNSUPPORTED_AGENT_MESSAGE);
      if (read.state.profiles.length > 0) throw new SubscriptionError(409, 'This agent is already connected. Disconnect it first to use another account.');

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

export function getLogin(agentId: string): LoginView | null {
  const j = jobs().get(agentId);
  if (!j) return null;
  expireIfOverdue(j);
  // A code that ran out while the process is still waiting.
  if (j.state === 'waiting' && j.expiresAt && Date.now() > j.expiresAt + 30_000) {
    void cancelLogin(agentId, 'expired');
  }
  return view(j);
}

/** Stop a login, inside the container too (`timeout` is only the backstop). */
export async function cancelLogin(agentId: string, as: 'cancelled' | 'expired' = 'cancelled'): Promise<LoginView | null> {
  const j = jobs().get(agentId);
  if (!j) return null;
  if (!ACTIVE.includes(j.state)) return view(j);
  j.cancelled = true;
  if (as === 'expired') finish(j, 'expired', 'The code expired before it was entered. Start again for a new one.');
  else finish(j, 'cancelled');
  const child = j.child;
  j.child = null;
  child?.kill('SIGTERM');
  // Killing the docker client leaves the process inside. The agent image has no pkill, so the
  // login (and its `timeout`/`script` wrappers) is found through /proc; the script is fixed
  // text and skips its own shell. `timeout` stays the backstop.
  if (j.container) await dockerExecNoFail(j.container, ['sh', '-c', KILL_LOGIN_SCRIPT], { timeoutMs: 5000 });
  return view(j);
}
