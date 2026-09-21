/**
 * Server-side host-port lookup for lib/agent-ports.ts. Split out because it uses
 * `child_process`, which client components cannot import.
 */
import { execSync } from 'child_process';

/**
 * Host ports published by any container, running or not: a stopped container keeps its
 * port allocations, so `docker run -p` on them fails just the same.
 *
 * Parsed in JS rather than piping through grep: the old `grep -oP '\d+(?=->)'` form lost
 * its backslash inside a template literal, matched nothing, and offered port 3700 to
 * every agent; `grep -P` is also GNU-only and absent on macOS.
 */
export function getUsedHostPorts(): Set<number> {
  try {
    const raw = execSync(`docker ps -a --format '{{.Ports}}'`, { encoding: 'utf-8', timeout: 3000 });
    const used = new Set<number>();
    for (const [, port] of raw.matchAll(/(\d+)->/g)) {
      const n = Number(port);
      if (Number.isInteger(n)) used.add(n);
    }
    return used;
  } catch {
    return new Set();
  }
}
