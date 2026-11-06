'use strict';

/**
 * Where the Docker Engine API socket is, and a JSON request against it.
 *
 * Plain CommonJS on purpose: the routes reach it through lib/docker-socket.ts, and
 * daemon.js — run by node directly, with no bundler — requires it. One copy of the rules
 * below, so the daemon cannot drift from the dashboard on where Docker lives.
 *
 * The socket path is NOT the same everywhere. `/var/run/docker.sock` is the Linux default
 * (and what the VPS uses), but Docker Desktop on macOS puts it at `~/.docker/run/docker.sock`
 * and does not create the /var/run symlink unless the user opts in. Hardcoding the Linux
 * path made every read-only Docker route return an empty list on macOS — agents existed
 * and ran, but the dashboard showed nothing, because creation shells out to the `docker`
 * CLI (which reads the context) while listing went through this socket.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let cached = null;
let lastMissAt = 0;

/**
 * How long a failed resolution is remembered. Long enough that a Docker outage doesn't
 * spawn a `docker context inspect` per request, short enough that a server which started
 * before the Docker daemon picks it up on its own.
 */
const MISS_TTL_MS = 5000;

function fromDockerHostEnv() {
  const raw = process.env.DOCKER_HOST;
  if (!raw) return null;
  // Only unix sockets are usable here; tcp:// would need a different client.
  if (!raw.startsWith('unix://')) return null;
  return raw.slice('unix://'.length);
}

function fromDockerContext() {
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

function usable(candidate) {
  if (!candidate) return null;
  try {
    fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Resolve the Docker socket, most authoritative source first. Returns null when Docker
 * isn't reachable at all.
 *
 * A success is cached for the life of the process — the path doesn't move. A failure is
 * only cached for MISS_TTL_MS: Rev4a can legitimately start before the Docker daemon is up
 * (systemd ordering, Docker Desktop still booting), and caching that failure permanently
 * would leave every Docker route returning an empty list until someone restarted the server.
 *
 * @returns {string | null}
 */
function resolveDockerSocket() {
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

/**
 * A request against the Docker Engine API, resolved as JSON. Rejects when Docker is
 * unreachable, the answer is an HTTP error (Docker's error bodies are JSON too — a status
 * is never resolved as data), the payload isn't JSON, or `timeoutMs` (when given) passes.
 *
 * @template [T=any]
 * @param {string} method
 * @param {string} apiPath
 * @param {number} [timeoutMs] 0 or omitted: no timeout
 * @param {AbortSignal} [signal] Optional cancellation, including an absolute deadline
 * @returns {Promise<T>}
 */
function dockerRequestJson(method, apiPath, timeoutMs = 0, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const socketPath = resolveDockerSocket();
    if (!socketPath) {
      reject(new Error('Docker socket not found'));
      return;
    }

    let response;
    let data = '';
    const onData = (chunk) => { data += chunk; };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      response?.removeListener('data', onData);
      data = '';
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onAbort = () => {
      const error = signal.reason instanceof Error ? signal.reason : new Error('Docker request aborted');
      cleanup();
      response?.destroy();
      req.destroy(error);
      reject(error);
    };
    const req = http.request(
      { socketPath, path: apiPath, method, headers: { Host: 'localhost' } },
      (res) => {
        response = res;
        res.on('error', fail);
        res.on('data', onData);
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            fail(new Error(`Docker error ${res.statusCode}: ${data.slice(0, 200) || '(no body)'}`));
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Invalid JSON from Docker')); }
          cleanup();
        });
      },
    );
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error('Docker request timed out')));
    req.on('error', fail);
    signal?.addEventListener('abort', onAbort, { once: true });
    req.end();
  });
}

module.exports = { resolveDockerSocket, dockerRequestJson };
