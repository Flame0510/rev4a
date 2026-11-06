/** Types for the CommonJS update state shared by bin/rev4a.js and the server. */

export type UpdatePhase = 'starting' | 'installing' | 'building' | 'restarting' | 'done' | 'failed';

export interface UpdateState {
  phase: UpdatePhase;
  from: string | null;
  to: string | null;
  startedAt: number;
  updatedAt: number;
  pid: number;
  /** Token of the run that started it, so a spawner can tell its own run from a competitor. */
  claim?: string;
  error?: string;
}

export interface ReadOptions {
  now?: number;
  isAlive?: (pid: number) => boolean;
  /** When the reading process started; a restarting update is done once it was started later. */
  startedAt?: number;
  /** The version the reading server runs (read once at its start); null/unknown skips the check. */
  runningVersion?: string | null;
  /** True for the server process: only it resolves `restarting`. Defaults to REV4A_SERVER_PID === this pid. */
  isServer?: boolean;
}

export const STATE_FILE: string;
export const STALE_MS: number;
export const CLAIM_ENV: string;
export const FUTURE_MS: number;
export const PHASES: UpdatePhase[];

export function stateFile(dataDir: string): string;
export function pidAlive(pid: unknown): boolean;
export function writeUpdate(
  dataDir: string,
  phase: UpdatePhase,
  patch?: { from?: string | null; to?: string | null; error?: string; pid?: number; claim?: string; startedAt?: number },
  now?: number,
): UpdateState | null;
export function clearUpdate(dataDir: string): void;
export function readUpdate(dataDir: string, opts?: ReadOptions): UpdateState | null;
export function currentUpdate(dataDir: string, opts?: ReadOptions): UpdateState | null;
export function isInProgress(state: UpdateState | null): boolean;
export function claimUpdate(
  dataDir: string,
  args?: { from?: string | null; claim?: string; pid?: number; inherited?: boolean; opts?: ReadOptions },
): { ok: boolean; state: UpdateState | null };
export function adoptPid(dataDir: string, claim: string, pid: number): boolean;
export function failClaimed(dataDir: string, claim: string, error: string, now?: number): boolean;
export function redact(text: string): string;
/** Shared key classifier for update logs and structured config redaction. */
export function isSecretName(name: string): boolean;
