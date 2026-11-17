/** Config environment reads and edits. Secrets require browser or bearer authentication. */
import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import { ENV_FILE } from '@/lib/rev4a-paths';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { saveEnvironment, parseEnvFile, isAllowedKey, dotenvKeys } from '@/lib/env-edit';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  try {
    let content = '';
    try {
      content = fs.readFileSync(ENV_FILE, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const vars = parseEnvFile(content);
    // Include inherited settings, but never per-process state or credentials.
    // A key the launcher copied from .env (REV4A_DOTENV_KEYS) is not a service value: once it is
    // cleared from .env it is gone, even though this process still has the old copy.
    const fromDotenv = dotenvKeys();
    for (const key of Object.keys(process.env).filter((k) => isAllowedKey(k) && !(k in vars) && !fromDotenv.has(k))) {
      vars[key] = process.env[key] || '';
    }
    return NextResponse.json({ env: vars });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  try { return saveEnvironment(await request.json()); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
}
