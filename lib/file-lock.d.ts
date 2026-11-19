import type { open } from 'node:fs/promises';

/** Coordinate short read-modify-write operations using flock. Server-only. */
export function withFileDirectoryLock<T>(file: string, operation: () => T | Promise<T>, options?: {
  io?: { open: typeof open };
  timeoutSeconds?: number;
  allowMissingFlock?: boolean;
}): Promise<T>;
