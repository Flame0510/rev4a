/**
 * One write queue per agent for `/root/.openclaw/openclaw.json`.
 *
 * Several things write that file: `openclaw config patch` (runtime config, the
 * Rev4a provider block, subscriptions, credentials) and three whole-file rewrites
 * (agent create, the gateway agent route, the channel manager). Two writers on one
 * agent at the same time lose an update, and a rewrite racing a patch can leave a
 * torn file. Every writer therefore runs through {@link withAgentConfigLock}: one
 * promise chain per container, so a writer starts only after the previous one on
 * the same agent has finished. Different agents never wait for each other.
 *
 * The chain lives on `globalThis` because Next bundles each route separately, and
 * every bundle must queue behind the same chain.
 *
 * Not re-entrant: a function running inside the lock must not call
 * `withAgentConfigLock` for the same container again, or it waits on itself.
 * Wrap the smallest unit that reads and writes the file, never a whole workflow.
 */

/** A holder running longer than this is logged (once); it is still waited for. */
export const LOCK_SLOW_MS = 2 * 60 * 1000;

interface LockState {
  chains: Map<string, Promise<void>>;
}

const g = globalThis as unknown as { __rev4aAgentConfigLock?: LockState };
const state: LockState = (g.__rev4aAgentConfigLock ??= { chains: new Map() });

/**
 * Run `fn` once every earlier writer on `container` has finished. A failure of an
 * earlier writer never blocks this one, and this one's result or error is returned
 * to its own caller unchanged.
 */
export function withAgentConfigLock<T>(
  container: string,
  fn: () => Promise<T>,
  slowMs: number = LOCK_SLOW_MS,
): Promise<T> {
  const prev = state.chains.get(container) ?? Promise.resolve();
  const run = async (): Promise<T> => {
    const timer = setTimeout(() => {
      console.warn(`[agent-config-lock] a writer on ${container} has held the lock for over ${Math.round(slowMs / 1000)}s`);
    }, slowMs);
    timer.unref?.();
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
    }
  };
  const result = prev.then(run);
  const tail: Promise<void> = result.then(() => undefined, () => undefined);
  state.chains.set(container, tail);
  void tail.then(() => {
    if (state.chains.get(container) === tail) state.chains.delete(container);
  });
  return result;
}
