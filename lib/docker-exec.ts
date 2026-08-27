/**
 * Running commands inside agent containers, without blocking the server.
 *
 * Every route that needed something from a container used to call `execSync` or
 * `execFileSync` directly. Those are synchronous: while one runs, Node's single
 * thread does nothing else — no other request is served, no agent's stream
 * advances. Node's own guidance names `execSync` in a server as a
 * denial-of-service vector, and the numbers here bear that out: a bare
 * `docker exec … echo` costs ~260ms, and the OpenClaw CLI inside a container
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
  /** Extra environment for the command, passed as `-e KEY=VALUE`. */
  env?: Record<string, string>;
  maxBuffer?: number;
  signal?: AbortSignal;
}

function baseArgs(container: string, opts?: DockerExecOptions): string[] {
  const args = ['exec'];
  for (const [k, v] of Object.entries(opts?.env ?? {})) args.push('-e', `${k}=${v}`);
  args.push(container);
  return args;
}

/**
 * Run a command inside a container, passing argv directly.
 *
 * Prefer this over {@link dockerExecShell}: with no shell in between there is
 * nothing to quote and nothing to escape, so a filename with a space or a quote
 * cannot turn into a second command.
 *
 * Rejects when the command fails, the container is missing, or the timeout hits.
 */
export async function dockerExec(
  container: string,
  argv: string[],
  opts?: DockerExecOptions,
): Promise<string> {
  if (!resolveDockerSocket()) throw new Error('Docker is not available');

  const { stdout } = await execFileAsync(
    'docker',
    [...baseArgs(container, opts), ...argv],
    {
      encoding: 'utf-8',
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts?.maxBuffer ?? DEFAULT_MAX_BUFFER,
      signal: opts?.signal,
    },
  );
  return stdout;
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
 * normal condition here — not something to fail a whole page over.
 */
export async function dockerExecNoFail(
  container: string,
  argv: string[],
  opts?: DockerExecOptions,
): Promise<string> {
  try {
    return await dockerExec(container, argv, opts);
  } catch {
    return '';
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
export function dockerExecWithInput(
  container: string,
  argv: string[],
  input: string,
  opts?: DockerExecOptions,
): Promise<string> {
  if (!resolveDockerSocket()) return Promise.reject(new Error('Docker is not available'));

  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', ...baseArgs(container, opts).slice(1), ...argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docker exec timed out after ${opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
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
