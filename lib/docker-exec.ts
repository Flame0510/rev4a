/**
 * Running commands inside agent containers, without blocking the server.
 *
 * Every route that needed something from a container used to call `execSync` or
 * `execFileSync` directly. Those are synchronous: while one runs, Node's single
 * thread does nothing else — no other request is served, no agent's stream
 * advances. Node's own guidance names `execSync` in a server as a
 * denial-of-service vector, and the numbers here bear that out: a bare
 * `docker exec … echo` costs ~90ms warm and ~225ms on the first call after an
 * idle period, and the OpenClaw CLI inside a container
 * takes 2.5–6s per invocation because it boots a whole Node process.
 *
 * Routes that walk every agent multiplied that: `/api/crons` measured 19.2s on a
 * seven-agent host, all of it with the event loop frozen.
 *
 * Everything here is async. The commands are still as slow as they were — that
 * cost belongs to the OpenClaw CLI — but they no longer stop the rest of the
 * server while they run.
 */
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { resolveDockerSocket } from '@/lib/docker-socket';

const execFileAsync = promisify(execFile);

/** Commands are expected to answer quickly; the OpenClaw CLI needs the headroom. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Matches what the previous callers passed, and covers `openclaw models list --json`. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface DockerExecOptions {
  timeoutMs?: number;
  /**
   * Extra environment for the command. Only the *names* reach argv, as `-e KEY`;
   * docker then forwards each value from its own environment. A value passed as
   * `-e KEY=VALUE` would sit in the process table for anyone on the host to read
   * with `ps`, and in the text of any rejection Node builds from that argv.
   */
  env?: Record<string, string>;
  maxBuffer?: number;
  signal?: AbortSignal;
  /**
   * Only for the `…NoFail` variants: on a deadline hit, return what the command had printed
   * instead of ''. Off by default, so a caller that treats any output as success is never
   * handed half an answer; the credentials probe opts in (its sentinel proves completeness).
   */
  partialOnTimeout?: boolean;
}

import {
  isTimeoutExit,
  clientTimeoutMs,
  buildExecArgs,
  isWrapperMissing,
  timeoutCause,
  unwrappedContainers as unwrapped,
} from './exec-timeout';

// The in-container deadline (`timeout -k 5 N`), its argv builder and exit-code
// mapping live in exec-timeout.js, shared with the daemon: see the explanation there.
export { isTimeoutExit, timeoutSeconds, clientTimeoutMs, buildExecArgs, isWrapperMissing, timeoutCause, unwrappedContainers } from './exec-timeout';

function envKeys(opts?: DockerExecOptions): string[] {
  return Object.keys(opts?.env ?? {});
}

/**
 * Rebuild a failure without the command that produced it.
 *
 * Node composes its own message as `Command failed: <argv…>\n<stderr>`, and the
 * argv holds whatever the caller put in the script. For credential delivery that
 * is the secret — base64 is encoding, not protection — and the message travels:
 * `syncProfileToAgents` puts it in `SyncResult.error`, which the sync route
 * returns to the browser. The most common failure of all, a revoked or expired
 * token, is exactly the one that triggers it.
 *
 * `stderr` is kept because that is the part that actually explains the failure.
 * A deadline hit inside the container (exit 124/137 of `timeout`) reads as
 * "timed out", like the host-side kill always did, and carries the partial
 * `stdout` so the `…NoFail` variants can keep returning what was printed.
 */
function execFailure(e: unknown, container: string, wrapped: boolean): Error {
  const err = e as { stderr?: string; stdout?: string; code?: number; killed?: boolean; name?: string };
  // An abort is the caller's own doing and is matched on elsewhere by name.
  if (err.name === 'AbortError') return e as Error;
  const timedOut = err.killed || (wrapped && isTimeoutExit(err.code));
  const cause = err.killed ? 'timed out' : timedOut ? timeoutCause(err.code) : err.code !== undefined ? `exit ${err.code}` : 'failed';
  const detail = (err.stderr ?? '').trim();
  const out = new Error(`docker exec ${container}: ${cause}${detail ? ` — ${detail}` : ''}`);
  if (timedOut) (out as Error & { partialStdout?: string }).partialStdout = typeof err.stdout === 'string' ? err.stdout : '';
  return out;
}

async function execOnce(container: string, argv: string[], opts: DockerExecOptions | undefined, wrap: boolean): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const { stdout } = await execFileAsync(
      'docker',
      buildExecArgs({ container, argv, envKeys: envKeys(opts), timeoutMs, wrap }),
      {
        encoding: 'utf-8',
        timeout: wrap ? clientTimeoutMs(timeoutMs) : timeoutMs,
        maxBuffer: opts?.maxBuffer ?? DEFAULT_MAX_BUFFER,
        signal: opts?.signal,
        ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
    );
    return stdout;
  } catch (e) {
    const err = e as { code?: number; stderr?: string; stdout?: string };
    const failure = execFailure(e, container, wrap);
    // Only a suspicion: the output of the wrapped command may hold any text (a path named "Usage: timeout").
    if (wrap && isWrapperMissing(err.code, `${err.stdout ?? ''}\n${err.stderr ?? ''}`)) throw Object.assign(new Error('no timeout binary'), { wrapperMissing: true, original: failure });
    throw failure;
  }
}

/**
 * Run a command inside a container, passing argv directly.
 *
 * Prefer this over {@link dockerExecShell}: with no shell in between there is
 * nothing to quote and nothing to escape, so a filename with a space or a quote
 * cannot turn into a second command.
 *
 * The command runs under `timeout` inside the container, so a deadline kills it
 * there too (see exec-timeout.js). Rejects when the command fails, the
 * container is missing, or the timeout hits.
 */
export async function dockerExec(
  container: string,
  argv: string[],
  opts?: DockerExecOptions,
): Promise<string> {
  if (!resolveDockerSocket()) throw new Error('Docker is not available');

  return runWithWrapperFallback(container, (wrap) => execOnce(container, argv, opts, wrap));
}

/** Runs the wrapper probe in a container; resolves to the failure's exit code and output, or null when it worked. */
export type WrapperProbe = (container: string) => Promise<{ code?: number; output: string } | null>;

/** The probe: `timeout -k 1 5 true` in the container, without the wrapper's own command. */
const defaultWrapperProbe: WrapperProbe = async (container) => {
  try {
    await execFileAsync('docker', ['exec', container, 'timeout', '-k', '1', '5', 'true'], { encoding: 'utf-8', timeout: 8_000, maxBuffer: 64 * 1024 });
    return null;
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : undefined, output: `${err.stdout ?? ''}\n${err.stderr ?? ''}` };
  }
};

/**
 * Runs `run(true)` (wrapped); when it fails in a way that looks like a missing `timeout`, a probe in the same
 * container decides. The wrapped command's own output is never enough: it can hold any text, for example the
 * name of a file that does not exist. Only when the probe fails the same way is the container remembered as
 * unwrapped and the command run again as `run(false)`; otherwise the original error is thrown.
 */
export async function runWithWrapperFallback<T>(
  container: string,
  run: (wrap: boolean) => Promise<T>,
  probe: WrapperProbe = defaultWrapperProbe,
  known: Set<string> = unwrapped(),
): Promise<T> {
  if (!known.has(container)) {
    try {
      return await run(true);
    } catch (e) {
      const flagged = e as { wrapperMissing?: boolean; original?: Error };
      if (!flagged.wrapperMissing) throw e;
      let failed: { code?: number; output: string } | null = null;
      try { failed = await probe(container); } catch { failed = null; }
      if (!failed || !isWrapperMissing(failed.code, failed.output)) throw flagged.original ?? e;
      // An image without `timeout`: remember it and run the command as before.
      known.add(container);
    }
  }
  return run(false);
}

/**
 * Run a shell command inside a container. Only for commands that genuinely need
 * a shell — pipes, redirection, globbing. Anything interpolated into `cmd` is
 * shell syntax, so callers must quote it themselves.
 */
export async function dockerExecShell(
  container: string,
  cmd: string,
  opts?: DockerExecOptions,
): Promise<string> {
  return dockerExec(container, ['sh', '-c', cmd], opts);
}

/**
 * As {@link dockerExec}, but resolves to '' instead of rejecting.
 *
 * This is the shape most of the existing callers want: a container that is
 * stopped, or an OpenClaw subcommand that isn't available on that agent, is a
 * normal condition here — not something to fail a whole page over. A deadline hit
 * inside the container also gives '' unless the caller sets `partialOnTimeout`.
 */
export async function dockerExecNoFail(
  container: string,
  argv: string[],
  opts?: DockerExecOptions,
): Promise<string> {
  try {
    return await dockerExec(container, argv, opts);
  } catch (e) {
    // A deadline hit inside the container: only a caller that opted in gets what the
    // command had printed (the credentials probe; its sentinel proves completeness).
    return opts?.partialOnTimeout ? ((e as { partialStdout?: string }).partialStdout ?? '') : '';
  }
}

/** Shell variant of {@link dockerExecNoFail}. */
export async function dockerExecShellNoFail(
  container: string,
  cmd: string,
  opts?: DockerExecOptions,
): Promise<string> {
  return dockerExecNoFail(container, ['sh', '-c', cmd], opts);
}

/**
 * Run a command inside a container and write `input` to its stdin.
 *
 * This uses `spawn` rather than `execFile` on purpose: `promisify(exec)` and
 * `promisify(execFile)` silently ignore an `input` option — the process starts,
 * stdin is never written, and the command hangs or reads nothing, with no error
 * to point at. `openclaw config patch --stdin` is the case that needs this.
 */
export async function dockerExecWithInput(
  container: string,
  argv: string[],
  input: string,
  opts?: DockerExecOptions,
): Promise<string> {
  if (!resolveDockerSocket()) throw new Error('Docker is not available');

  return runWithWrapperFallback(container, (wrap) => spawnOnce(container, argv, input, opts, wrap));
}

function spawnOnce(
  container: string,
  argv: string[],
  input: string,
  opts: DockerExecOptions | undefined,
  wrap: boolean,
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', buildExecArgs({ container, argv, envKeys: envKeys(opts), interactive: true, timeoutMs, wrap }), {
      stdio: ['pipe', 'pipe', 'pipe'],
      // `buildExecArgs` names the variables but carries no values, so they have to
      // reach docker through its own environment — without this the container
      // would be handed empty variables and never say why.
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docker exec timed out after ${timeoutMs}ms`));
    }, wrap ? clientTimeoutMs(timeoutMs) : timeoutMs);

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else if (wrap && isWrapperMissing(code, `${stdout}\n${stderr}`)) reject(Object.assign(new Error('no timeout binary'), { wrapperMissing: true, original: new Error(stderr.trim() || `docker exec exited with code ${code}`) }));
      else if (wrap && isTimeoutExit(code)) reject(new Error(`docker exec ${timeoutCause(code)} after ${timeoutMs}ms`));
      else reject(new Error(stderr.trim() || `docker exec exited with code ${code}`));
    });

    child.stdin.on('error', () => { /* the close handler reports the real failure */ });
    child.stdin.end(input);
  });
}

/**
 * Map over items with a cap on how many run at once.
 *
 * The point of making these calls async is to run an agent fleet's worth of them
 * concurrently instead of one after another. Doing that with a bare
 * `Promise.all` would spawn one `docker exec` per agent simultaneously, which is
 * fine for seven agents and not fine for seventy — each one is a process, and
 * the Docker daemon serialises past a point anyway. The cap keeps the win
 * without trading a frozen event loop for a swamped daemon.
 *
 * Results keep the order of `items`, regardless of completion order.
 *
 * Fail-fast, like `Promise.all`: if `fn` rejects for one item the whole call
 * rejects. That is deliberate — silently swallowing failures here would hide
 * real errors — but it means callers fanning out over an agent fleet should pass
 * a function that handles its own failures (the `…NoFail` variants above, or an
 * explicit try/catch), so one unreachable container can't blank an entire page.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
