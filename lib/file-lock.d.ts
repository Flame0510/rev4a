/** Coordinate short read-modify-write operations using flock when available. Server-only. */
export function withFileDirectoryLock<T>(file: string, operation: () => T | Promise<T>): Promise<T>;
