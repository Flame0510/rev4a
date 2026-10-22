/**
 * A process-wide async lock for the gateway token.
 *
 * Saving the token (file, then every running container) and creating an agent (token read, then
 * `docker run`) must not interleave: two saves would leave the file on one token and the
 * containers on another, and a save during a create would miss the container that is not yet
 * listed by `docker ps`. The chain lives on `globalThis` because Next.js bundles each route
 * separately, so a module-level variable would be one lock per route.
 */
const KEY = Symbol.for('rev4a.agentTokenLock');

type Holder = { tail: Promise<void> };

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  return (g[KEY] ??= { tail: Promise.resolve() });
}

/** Waits for the lock and resolves to its release function (safe to call more than once). */
export async function acquireTokenLock(): Promise<() => void> {
  const h = holder();
  const previous = h.tail;
  let release!: () => void;
  h.tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}

/** Runs `fn` while holding the lock; the lock is released when `fn` settles. */
export async function withTokenLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireTokenLock();
  try {
    return await fn();
  } finally {
    release();
  }
}
