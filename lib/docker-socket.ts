/**
 * Docker Engine API over its local unix socket.
 *
 * The socket path is NOT the same everywhere. `/var/run/docker.sock` is the
 * Linux default (and what the VPS uses), but Docker Desktop on macOS puts it
 * at `~/.docker/run/docker.sock` and does not create the /var/run symlink
 * unless the user opts in. Hardcoding the Linux path made every read-only
 * Docker route return an empty list on macOS — agents existed and ran, but
 * the dashboard showed nothing, because creation shells out to the `docker`
 * CLI (which reads the context) while listing went through this socket.
 *
 * Talking to the socket directly is preferred over shelling out for reads:
 * no fork, no shell quoting, no `--format` template to parse — just JSON.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

let cached: string | null = null;
let lastMissAt = 0;

/**
 * How long a failed resolution is remembered. Long enough that a Docker outage
 * doesn't spawn a `docker context inspect` per request, short enough that a
 * server which started before the Docker daemon picks it up on its own.
 */
const MISS_TTL_MS = 5000;

function fromDockerHostEnv(): string | null {
  const raw = process.env.DOCKER_HOST;
  if (!raw) return null;
  // Only unix sockets are usable here; tcp:// would need a different client.
  if (!raw.startsWith('unix://')) return null;
  return raw.slice('unix://'.length);
}

function fromDockerContext(): string | null {
  try {
    const out = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out.startsWith('unix://') ? out.slice('unix://'.length) : null;
  } catch {
    return null;
  }
}

function usable(candidate: string | null): string | null {
  if (!candidate) return null;
  try {
    fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Resolve the Docker socket, most authoritative source first. Returns null when
 * Docker isn't reachable at all.
 *
 * A success is cached for the life of the process — the path doesn't move. A
 * failure is only cached for MISS_TTL_MS: Rev4a can legitimately start before
 * the Docker daemon is up (systemd ordering, Docker Desktop still booting), and
 * caching that failure permanently would leave every Docker route returning an
 * empty list until someone restarted the server.
 */
export function resolveDockerSocket(): string | null {
  if (cached) return cached;
  if (Date.now() - lastMissAt < MISS_TTL_MS) return null;

  const found =
    usable(fromDockerHostEnv()) ??
    usable(fromDockerContext()) ??
    // Docker Desktop (macOS, and Windows with WSL integration)
    usable(path.join(os.homedir(), '.docker', 'run', 'docker.sock')) ??
    // Linux default — the VPS lands here
    usable('/var/run/docker.sock');

  if (found) cached = found;
  else lastMissAt = Date.now();

  return found;
}

/** True when a usable Docker socket exists. */
export function dockerAvailable(): boolean {
  return resolveDockerSocket() !== null;
}

/**
 * GET/POST against the Docker Engine API, resolving the response as JSON.
 * Rejects when Docker is unreachable or the payload isn't JSON.
 */
export function dockerFetch<T = any>(method: string, apiPath: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const socketPath = resolveDockerSocket();
    if (!socketPath) {
      reject(new Error('Docker socket not found'));
      return;
    }

    const req = http.request(
      { socketPath, path: apiPath, method, headers: { Host: 'localhost' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data) as T); }
          catch { reject(new Error('Invalid JSON from Docker')); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
