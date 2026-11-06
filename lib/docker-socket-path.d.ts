/** Types for the CommonJS Docker socket client shared with daemon.js. */

export function resolveDockerSocket(): string | null;

export function dockerRequestJson<T = unknown>(
  method: string,
  apiPath: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<T>;
