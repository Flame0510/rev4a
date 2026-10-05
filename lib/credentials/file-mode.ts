import fs from 'node:fs';
import path from 'node:path';

// credentials.db holds third-party secrets in clear, so it is readable by its owner only.
// SQLite creates the -wal and -shm companions with the mode of the main file.
const SECURE_MODE = 0o600;

// A failed chmod is reported once per process and never stops the vault from working.
const warned = new Set<string>();

function warnOnce(file: string, err: unknown): void {
  if (warned.has(file)) return;
  warned.add(file);
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[credentials] could not set 0600 on ${file}: ${message}`);
}

function chmodIfExists(file: string): void {
  if (!fs.existsSync(file)) return;
  try {
    fs.chmodSync(file, SECURE_MODE);
  } catch (err) {
    // Not the owner, a read-only filesystem or Windows: warn and keep the vault usable.
    warnOnce(file, err);
  }
}

/**
 * Make credentials.db and its WAL companions owner-only (0600).
 *
 * A missing database is created empty first, so SQLite never creates it under the process
 * umask (0644 on a default install). Never throws: a failed chmod is logged once per file
 * and the vault keeps working.
 */
export function secureDbFiles(dbPath: string): void {
  const dir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    warnOnce(dir, err);
  }

  if (!fs.existsSync(dbPath)) {
    let fd: number | null = null;
    try {
      // 'wx' fails when another process created the file in the meantime; that is fine.
      fd = fs.openSync(dbPath, 'wx', SECURE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') warnOnce(dbPath, err);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Nothing to close.
        }
      }
    }
  }

  chmodIfExists(dbPath);
  chmodIfExists(`${dbPath}-wal`);
  chmodIfExists(`${dbPath}-shm`);
}
