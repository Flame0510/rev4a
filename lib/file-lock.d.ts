/** Coordinate short read-modify-write operations across processes (flock on the directory). Server-only. */
export function withFileDirectoryLock<T>(file: string, operation: () => T | Promise<T>): Promise<T>;
