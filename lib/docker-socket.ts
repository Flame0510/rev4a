/**
 * Docker Engine API over its local unix socket.
 *
 * Talking to the socket directly is preferred over shelling out for reads: no fork, no
 * shell quoting, no `--format` template to parse — just JSON.
 *
 * Where the socket lives (it is NOT the same on Linux and on Docker Desktop) and the
 * request itself are in lib/docker-socket-path.js, plain CommonJS shared with daemon.js so
 * there is one copy of those rules; this module keeps the names the routes import.
 */
import { resolveDockerSocket as resolve, dockerRequestJson } from './docker-socket-path';

/**
 * Resolve the Docker socket, most authoritative source first. Returns null when Docker
 * isn't reachable at all (a failure is remembered for a few seconds only).
 */
export function resolveDockerSocket(): string | null {
  return resolve();
}

/** True when a usable Docker socket exists. */
export function dockerAvailable(): boolean {
  return resolveDockerSocket() !== null;
}

/**
 * GET/POST against the Docker Engine API, resolving the response as JSON.
 * Rejects when Docker is unreachable or the payload isn't JSON.
 */
export function dockerFetch<T = any>(method: string, apiPath: string, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  return dockerRequestJson<T>(method, apiPath, timeoutMs, signal);
}
