/**
 * Waiting for an agent's Gateway to finish starting.
 *
 * **Which endpoint.** OpenClaw exposes three, answering three different questions:
 *
 *   /health, /healthz    the HTTP server is listening
 *   /startupz            startup finished and the Gateway is not draining
 *   /readyz              the above, plus configured channels pass deep checks
 *
 * `/startupz` is the one callers need: the create route configures the agent as
 * soon as this returns. A Gateway that refused readiness — for instance one that
 * found a legacy session store and wants `doctor --fix` — still answers 200 on
 * `/health`. `/readyz` would fail on an expired channel token, and the create
 * route deletes the container when this probe times out, so a false negative
 * there destroys a healthy agent over an unrelated channel.
 *
 * **The endpoint used.** `/startupz` is the probe on every supported version (2026.9.x): 503 while starting or
 * draining, 200 with `{"status":"started"}` when done. The probe reads the status
 * code *and* the body: a 503, a non-JSON 200 or no answer means "not yet". A
 * Gateway that refused readiness — for instance one that found a legacy session
 * store and wants `doctor --fix` — answers 200 on `/health` while draining; reading
 * that as ready would let the create route configure an agent that is still
 * migrating.
 *
 * **One rule, one place.** {@link probeGateway} is the single attempt that applies the
 * rule above; {@link waitForGatewayReady} polls it, and the Agents page status
 * (lib/gateway-status.ts) and the Open route call it once. Nothing else reads
 * `/startupz` to decide readiness.
 *
 * **Async.** A request path must not hold Node's single thread for up to a
 * minute; see docs/ARCHITECTURE.md §3.1.
 */
import { dockerExec } from '@/lib/docker-exec';

/** Interval between attempts. The Gateway takes seconds to boot, not milliseconds. */
const POLL_INTERVAL_MS = 2_000;

/** Per-attempt budget. Generous: a loaded host can be slow to answer. */
const ATTEMPT_TIMEOUT_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One HTTP GET from inside the container, with its status code.
 *
 * `curl -w` appends the code as the last line. `status` is 0 when nothing usable
 * came back. A deadline may reject, or resolve with truncated output because
 * `docker exec` can exit 0 on the SIGTERM (docs/ARCHITECTURE.md, "A timeout does
 * not reject"); either way a last line that is not a three-digit code counts as
 * no answer. The image has `curl`, not `wget`.
 *
 * curl runs under `sh -c '…; exit 0'` so a refused connection (the usual answer while
 * the Gateway boots) exits 0 and is told apart from the exec itself failing. What
 * rejects then is a deadline (it carries `partialStdout`: no answer) or Docker (the
 * container is gone, exec not possible): that one is `error`.
 */
async function probe(container: string, path: string, timeoutMs: number): Promise<{ status: number; body: string } | 'error'> {
  let out: string;
  try {
    out = await dockerExec(
      container,
      ['sh', '-c', `curl -s --max-time ${Math.max(1, Math.ceil(timeoutMs / 1000))} -o - -w '\\n%{http_code}' http://127.0.0.1:3000${path}; exit 0`],
      { timeoutMs },
    );
  } catch (e) {
    if ((e as { partialStdout?: string }).partialStdout !== undefined) return { status: 0, body: '' };
    return 'error';
  }
  if (!out) return { status: 0, body: '' };
  const cut = out.lastIndexOf('\n');
  const tail = (cut === -1 ? out : out.slice(cut + 1)).trim();
  if (!/^\d{3}$/.test(tail)) return { status: 0, body: '' };
  return { status: Number(tail), body: cut === -1 ? '' : out.slice(0, cut) };
}

function asJson(body: string): Record<string, unknown> | null {
  if (!body.trimStart().startsWith('{')) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The answer of one probe: `ready` only for 200 + `status: "started"`; `error` when the exec itself failed. */
export type GatewayProbe = 'ready' | 'starting' | 'no_answer' | 'error';

/**
 * One attempt at `/startupz`. `ready` for HTTP 200 with JSON `status === "started"`,
 * `starting` for a 503 (starting or draining), `no_answer` for anything else: no
 * answer, a timeout, a truncated reply or any other code; `error` when `docker exec` itself
 * fails (container gone, Docker error). Never throws.
 */
export async function probeGateway(container: string, timeoutMs = ATTEMPT_TIMEOUT_MS): Promise<GatewayProbe> {
  const startupz = await probe(container, '/startupz', timeoutMs);
  if (startupz === 'error') return 'error';
  if (startupz.status === 200) {
    const json = asJson(startupz.body);
    // Accept only the answer that means startup finished. A 200 with any other body
    // is not a ready Gateway.
    return json && json.status === 'started' ? 'ready' : 'no_answer';
  }
  if (startupz.status === 503) return 'starting';
  return 'no_answer';
}

/**
 * Poll a container's Gateway until it has finished starting.
 *
 * Resolves `true` on the first affirmative answer, `false` on timeout. Never
 * throws: an unreachable container is indistinguishable from a slow one until the
 * deadline passes, and every caller treats both the same way.
 */
export async function waitForGatewayReady(
  container: string,
  // Generous: a first boot migrates and seeds the volume, and a loaded host can
  // stretch that well past a minute. A too-short window deletes a healthy agent
  // (the create route removes the container on timeout), so bias to waiting.
  timeoutMs = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await probeGateway(container)) === 'ready') return true;
    // Starting, draining, any other code, or no answer: not yet.

    // Only sleep if there is still budget left to use afterwards.
    if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}
