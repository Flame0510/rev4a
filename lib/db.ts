// Shared DB helpers for API routes
import Database from 'better-sqlite3';
import { initializeRev4aDb } from './db-bootstrap.mjs';
import { DB_FILE } from './rev4a-paths';

export const DB_PATH = process.env.REV4A_DB || DB_FILE;

export function ensureDbReady(): void {
  initializeRev4aDb(DB_PATH);
}

export function openDb(readonly = true): Database.Database {
  ensureDbReady();
  return new Database(DB_PATH, { readonly });
}
