import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DB_PATH } from '@/lib/db';
import { secureDbFiles } from './file-mode';

// credentials.db lives alongside events.db in the same data directory
export const CREDENTIALS_DB_PATH =
  process.env.REV4A_CREDENTIALS_DB ??
  path.join(path.dirname(DB_PATH), 'credentials.db');

// Tighten the vault files once per process, before SQLite creates credentials.db under the umask.
let filesSecured = false;

function bootstrap(): void {
  if (!filesSecured) {
    filesSecured = true;
    secureDbFiles(CREDENTIALS_DB_PATH);
  }
  fs.mkdirSync(path.dirname(CREDENTIALS_DB_PATH), { recursive: true });
  const db = new Database(CREDENTIALS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_profiles (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      secret_masked TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS credential_secrets (
      profile_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credential_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      profile_id TEXT,
      result TEXT
    );

    -- Which agent receives which credential, and how. agent_id is the container name.
    CREATE TABLE IF NOT EXISTS credential_assignments (
      profile_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'env',
      synced_at INTEGER,
      last_error TEXT,
      pending_removal INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (profile_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cred_profiles_provider ON credential_profiles(provider_id);
    CREATE INDEX IF NOT EXISTS idx_cred_audit_ts ON credential_audit_log(ts);
  `);
  // Additive and idempotent: a table created before pending_removal existed gets the column once.
  const cols = db.prepare("PRAGMA table_info(credential_assignments)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'pending_removal')) {
    db.exec("ALTER TABLE credential_assignments ADD COLUMN pending_removal INTEGER NOT NULL DEFAULT 0");
  }
  db.close();
  // Again after SQLite's first open: a database path that is a symlink to a missing file is
  // created by SQLite itself, under the umask, so it is tightened only now.
  secureDbFiles(CREDENTIALS_DB_PATH);
}

// Track whether the full bootstrap (including migrations) has run
let ready = false;

function migrateV1(): void {
  // v0 → v1: rename encrypted_payload → payload, drop key_version
  // This is safe because credentials.db was never shipped with real data
  const db = new Database(CREDENTIALS_DB_PATH);
  try {
    // Check if the old column exists
    const cols = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='credential_secrets'").get() as { sql: string } | null;
    if (cols && cols.sql.includes('encrypted_payload')) {
      db.exec(`
        CREATE TABLE credential_secrets_v1 (
          profile_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        );
        INSERT INTO credential_secrets_v1 (profile_id, payload)
          SELECT profile_id, encrypted_payload FROM credential_secrets;
        DROP TABLE credential_secrets;
        ALTER TABLE credential_secrets_v1 RENAME TO credential_secrets;
      `);
    }
  } finally {
    db.close();
  }
}

let migrationDone = false;

export function openCredentialsDb(readonly = true): Database.Database {
  if (!ready) {
    bootstrap();
    ready = true;
  }
  if (!migrationDone && !readonly) {
    migrateV1();
    migrationDone = true;
  }
  return new Database(CREDENTIALS_DB_PATH, { readonly });
}
