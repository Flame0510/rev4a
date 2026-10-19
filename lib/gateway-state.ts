/**
 * What the Agents page shows about an agent's Gateway, as a pure decision.
 *
 * Docker reports a container `running` the moment it starts; the OpenClaw Gateway
 * inside needs seconds to minutes. This file turns Docker's state, the start time and
 * one `/startupz` probe (lib/agent-readiness.ts) into one of five states. It imports
 * nothing so a node test can load it.
 */

export type GatewayState = 'stopped' | 'starting' | 'ready' | 'not_ready' | 'unknown';

/** The probe answers, repeated here to stay dependency-free; `error` or `null` means it could not run. */
export type GatewayProbeResult = 'ready' | 'starting' | 'no_answer' | 'error' | null | undefined;

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
