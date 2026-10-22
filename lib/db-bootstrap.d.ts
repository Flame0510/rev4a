declare module '*/db-bootstrap.mjs' {
  export function initializeRev4aDb(dbPath: string, options?: { timeout?: number }): void;
}
