/** Types for the CommonJS in-container deadline shared with daemon.js. */

export const KILL_AFTER_S: number;

export function isTimeoutExit(code: unknown): boolean;
export function timeoutSeconds(timeoutMs: number): number;
export function clientTimeoutMs(timeoutMs: number): number;

export interface ExecArgsInput {
  container: string;
  argv: string[];
  /** Names only, passed as `-e KEY`; never values. */
  envKeys?: string[];
  /** `-i`, for commands that read stdin. */
  interactive?: boolean;
  timeoutMs: number;
  /** False for a container whose image has no `timeout`. */
  wrap: boolean;
}

export function buildExecArgs(input: ExecArgsInput): string[];
/** `output` is stdout and stderr joined. */
export function isWrapperMissing(code: unknown, output: string): boolean;
export function timeoutCause(code: unknown): string;
export function unwrappedContainers(): Set<string>;
