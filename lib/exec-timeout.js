/**
 * The in-container deadline for `docker exec`, shared by the dashboard (lib/docker-exec.ts,
 * lib/openclaw-cron.ts) and the daemon (daemon.js, CommonJS). One implementation.
 *
 * Node's `timeout` option kills only the `docker` CLI client. The process in the container has
 * no TTY and receives no signal, so it keeps running: a poll that gave up left an
 * `openclaw devices list` (~200 MB of Node, far more under emulation) behind each time, and
 * dozens piled up until the host crawled. The deadline therefore has to be enforced inside the
 * container, by GNU `timeout` (SIGTERM at the deadline, SIGKILL 5 s later). The host-side timer
 * stays as a safety net, a few seconds longer.
 */
'use strict';

/** Passed as `-k 5`, not `--kill-after=5`: GNU coreutils accepts both, busybox (alpine) only the short form. */
const KILL_AFTER_S = 5;
/** Extra time the host-side timer allows beyond the in-container deadline plus its kill-after. */
const CLIENT_GRACE_MS = 3_000;

/** Exit codes of `timeout` itself: 124 on the deadline, 137 (128 + SIGKILL) after --kill-after. */
function isTimeoutExit(code) {
  return code === 124 || code === 137;
}

/** Whole seconds for `timeout`: never rounded down, and at least one. */
function timeoutSeconds(timeoutMs) {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

/** How long the host-side timer waits: the in-container limit, its kill-after and a grace. */
function clientTimeoutMs(timeoutMs) {
  return timeoutSeconds(timeoutMs) * 1000 + KILL_AFTER_S * 1000 + CLIENT_GRACE_MS;
}

/**
 * The argv for `docker`, built as an array: nothing here goes through a shell. The wrapper adds
 * only `timeout -k 5 N`; no value of the caller's is in it. `envKeys` are names only
 * (`-e KEY`), `interactive` adds `-i`, `wrap: false` is for a container whose image has no
 * `timeout`.
 */
function buildExecArgs({ container, argv, envKeys = [], interactive = false, timeoutMs, wrap }) {
  const args = ['exec'];
  if (interactive) args.push('-i');
  for (const k of envKeys) args.push('-e', k);
  args.push(container);
  if (wrap) args.push('timeout', '-k', String(KILL_AFTER_S), String(timeoutSeconds(timeoutMs)));
  args.push(...argv);
  return args;
}

/**
 * True when a failed wrapped exec failed because the wrapper cannot be used in this image (as
 * opposed to the wrapped command failing): no `timeout` binary, or one that rejects `-k` (an
 * old busybox). `output` is stdout AND stderr joined: Docker Desktop 29 prints its
 * `OCI runtime exec failed: … exec: "timeout": executable file not found in $PATH` on STDOUT
 * (exit 127), other versions on stderr.
 */
function isWrapperMissing(code, output) {
  const text = String(output || '');
  if (code === 125 || code === 126 || code === 127) {
    return /timeout/i.test(text) && /not found|executable file not found/i.test(text);
  }
  if (code === 1) return /timeout: (?:unrecognized|invalid) option|Usage: timeout/i.test(text);
  return false;
}

/** Wording for a 124/137 exit: 137 is also what an out-of-memory kill of the command looks like. */
function timeoutCause(code) {
  return code === 137 ? 'timed out or was killed (exit 137)' : 'timed out';
}

/** Containers known to lack `timeout`: they run unwrapped from then on (in memory only). */
function unwrappedContainers() {
  const g = globalThis;
  if (!g.__rev4aNoTimeoutContainers) g.__rev4aNoTimeoutContainers = new Set();
  return g.__rev4aNoTimeoutContainers;
}

module.exports = {
  KILL_AFTER_S,
  isTimeoutExit,
  timeoutSeconds,
  clientTimeoutMs,
  buildExecArgs,
  isWrapperMissing,
  timeoutCause,
  unwrappedContainers,
};
