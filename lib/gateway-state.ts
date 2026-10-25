/**
 * What the Agents page shows about an agent's Gateway, as a pure decision.
 *
 * Docker reports a container `running` the moment it starts; the OpenClaw Gateway
 * inside needs seconds to minutes. This file turns Docker's state, the start time and
 * one `/startupz` probe (lib/agent-readiness.ts) into one of five states. It imports
 * nothing so a node test can load it.
 *
 * Three rules live here:
 *   - `gatewayState`: the state shown on the page. Only a 503 or no answer at all mean
 *     "still starting"; an HTTP answer Rev4a does not understand (`unexpected`) is `unknown`.
 *   - `blocksOpen`: Open is blocked only by a real 503 inside the budget, never by a timeout.
 *   - `nextStartAnchor`: where the budget clock starts. A restart policy resets Docker's
 *     `StartedAt` at every restart, so a crash loop would stay `starting` for ever; the
 *     clock is anchored at the first start Rev4a saw and moves only on a manual restart.
 */

export type GatewayState = 'stopped' | 'starting' | 'ready' | 'not_ready' | 'unknown';

/** The probe answers, repeated here to stay dependency-free; `error` or `null` means it could not run. */
export type GatewayProbeResult = 'ready' | 'starting' | 'no_answer' | 'unexpected' | 'error' | null | undefined;

/** Past this a Gateway that never became ready is called not ready (the update's migration budget). */
export const NOT_READY_AFTER_MS = 10 * 60_000;

export interface GatewayStateInput {
  running: boolean;
  /** `State.StartedAt` as ms since the epoch; missing or NaN when unknown. */
  startedAtMs: number | null | undefined;
  probe: GatewayProbeResult;
  nowMs: number;
  notReadyAfterMs?: number;
}

export function gatewayState(input: GatewayStateInput): GatewayState {
  const { running, startedAtMs, probe, nowMs } = input;
  const notReadyAfterMs = input.notReadyAfterMs ?? NOT_READY_AFTER_MS;
  if (!running) return 'stopped';
  if (probe === 'ready') return 'ready';
  if (probe !== 'starting' && probe !== 'no_answer') return 'unknown';
  // Without a usable start time there is no clock to run out: never `not_ready`.
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs <= 0) return 'starting';
  // A start time in the future (clock skew) gives a negative age, hence `starting`.
  return nowMs - startedAtMs < notReadyAfterMs ? 'starting' : 'not_ready';
}

/**
 * Whether the Open button (and the Open route) must refuse: only when the Gateway itself
 * answered 503 (starting or draining) and the state is still `starting`. No answer, an
 * unexpected answer, an error, `not_ready` or `stopped` never block.
 */
export function blocksOpen(probe: GatewayProbeResult, state: GatewayState): boolean {
  return probe === 'starting' && state === 'starting';
}

/** The budget clock of one container: when it started for good, and the restart count seen then. */
export interface StartAnchor {
  anchorMs: number;
  restartCount: number;
}

export interface StartAnchorObservation {
  /** `State.StartedAt` as ms since the epoch; missing or NaN when unknown. */
  startedAtMs: number | null | undefined;
  /** `RestartCount` from the container inspect (0 when missing). */
  restartCount: number;
  /** The Gateway answered ready. */
  ready: boolean;
}

function usableMs(ms: number | null | undefined): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
}

/**
 * The next anchor of a container, given the previous one and what Docker says now.
 * `null` means no anchor (ready, or no usable start time seen yet): the state then
 * behaves as without a clock.
 *
 *   - ready: cleared.
 *   - no previous anchor: the start time.
 *   - `restartCount` grew (a policy restart): keep the previous anchor.
 *   - `restartCount` shrank, or is 0 with another start time (a manual restart or
 *     stop + start): the new start time.
 *   - otherwise: keep the previous anchor.
 */
export function nextStartAnchor(prev: StartAnchor | null | undefined, obs: StartAnchorObservation): StartAnchor | null {
  if (obs.ready) return null;
  const restartCount = Number.isFinite(obs.restartCount) && obs.restartCount > 0 ? obs.restartCount : 0;
  if (!prev) return usableMs(obs.startedAtMs) ? { anchorMs: obs.startedAtMs, restartCount } : null;
  if (restartCount > prev.restartCount) return { anchorMs: prev.anchorMs, restartCount };
  if (usableMs(obs.startedAtMs) && (restartCount < prev.restartCount || (restartCount === 0 && obs.startedAtMs !== prev.anchorMs))) {
    return { anchorMs: obs.startedAtMs, restartCount };
  }
  return { anchorMs: prev.anchorMs, restartCount };
}

/** A request that has been in flight this long is presumed stuck: ticks stop waiting for it. */
export const GATEWAY_POLL_STUCK_MS = 20_000;

/**
 * Whether an interval tick of the Agents page must skip because the previous Gateway
 * request is still in flight (`inFlightSinceMs` is its start, `null` when none). A tick
 * never aborts a request; it only waits, up to {@link GATEWAY_POLL_STUCK_MS}.
 */
export function skipGatewayTick(inFlightSinceMs: number | null | undefined, nowMs: number): boolean {
  if (typeof inFlightSinceMs !== 'number' || !Number.isFinite(inFlightSinceMs)) return false;
  return nowMs - inFlightSinceMs < GATEWAY_POLL_STUCK_MS;
}
