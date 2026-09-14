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
 * **Two OpenClaw majors.** `/startupz` exists from 9.x: 503 while starting or
 * draining, 200 with `{"status":"started"}` when done. The 2026.7.1-2 image that
 * `openclaw-agent-base` currently pins has no `/startupz`; its Gateway answers
 * every unknown path with 200 and the web UI's HTML. So the probe reads the
 * status code *and* the body, and falls back to `/health` only for a 200 that is
 * not JSON — the old image. A 503, or no answer, means "not yet", never "use
 * `/health`": reading an empty answer as "old image" makes a 9.x Gateway count as
 * ready the moment it starts listening.
 *
 * Delete the `/health` fallback once every image is on 9.x.
 *
 * **Async.** A request path must not hold Node's single thread for up to a
 * minute; see docs/ARCHITECTURE.md §3.1.
 */
import { dockerExecNoFail } from '@/lib/docker-exec';

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
 */
async function probe(container: string, path: string): Promise<{ status: number; body: string }> {
  const out = await dockerExecNoFail(
    container,
    ['curl', '-s', '-o', '-', '-w', '\n%{http_code}', `http://127.0.0.1:3000${path}`],
    { timeoutMs: ATTEMPT_TIMEOUT_MS },
  );
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

/**
 * Poll a container's Gateway until it has finished starting.
 *
 * Resolves `true` on the first affirmative answer, `false` on timeout. Never
 * throws: an unreachable container is indistinguishable from a slow one until the
 * deadline passes, and every caller treats both the same way.
 */
export async function waitForGatewayReady(
  container: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const startupz = await probe(container, '/startupz');

    if (startupz.status === 200) {
      const json = asJson(startupz.body);
      if (json) {
        // 9.x: accept only the answer that means startup finished.
        if (json.status === 'started') return true;
      } else {
        // 200 with a non-JSON body: the 2026.7.1-2 web UI catch-all, so this build
        // has no /startupz. Liveness is the best signal it offers.
        const health = await probe(container, '/health');
        const h = health.status === 200 ? asJson(health.body) : null;
        if (h && (h.ok === true || h.status === 'live')) return true;
      }
    }
    // 503 (starting or draining), any other code, or no answer: not yet.

    // Only sleep if there is still budget left to use afterwards.
    if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}
