// Shared DB helpers for API routes
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { initializeRev4aDb } from './db-bootstrap.mjs';
import { DB_FILE } from './rev4a-paths';

export const DB_PATH = process.env.REV4A_DB || DB_FILE;
export const TOKEN = process.env.REV4A_TOKEN ?? '';

export function requireAuth(request: NextRequest): NextResponse | null {
  const token = new URL(request.url).searchParams.get('token');
  const auth = request.headers.get('authorization');
  const ok = token === TOKEN || auth === `Bearer ${TOKEN}`;
  return ok ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export function ensureDbReady(): void {
  initializeRev4aDb(DB_PATH);
}

export function openDb(readonly = true): Database.Database {
  ensureDbReady();
  return new Database(DB_PATH, { readonly });
}
