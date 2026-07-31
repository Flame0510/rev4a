import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { join } from 'path';
import { existsSync, mkdirSync, appendFileSync } from 'fs';

interface PackageInfo {
  version: string;
  name: string;
}
let pkg: PackageInfo;
try {
  pkg = require('../../../package.json') as PackageInfo;
} catch {
  pkg = { version: '0.0.0', name: '@flame0510/olympus' };
}

interface CachedResult {
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number;
}

let cache: CachedResult | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * GET /api/update-check
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const check = url.searchParams.get('check') === '1';

  const installed = pkg.version || '0.0.0';
  let latest: string | null = null;
  let updateAvailable = false;

  if (check) {
    const now = Date.now();
    if (cache && now - cache.checkedAt < CACHE_TTL_MS) {
      latest = cache.latest;
      updateAvailable = cache.updateAvailable;
    } else {
      try {
        const pkgName = pkg.name || '@flame0510/olympus';
        latest = execSync(
          `npm view ${pkgName} version --registry https://registry.npmjs.org 2>/dev/null`,
          { stdio: 'pipe', timeout: 10_000 },
        ).toString().trim();

        if (latest && latest !== installed) {
          updateAvailable = true;
        }
        cache = { latest, updateAvailable, checkedAt: now };
      } catch {
        if (cache) {
          latest = cache.latest;
          updateAvailable = cache.updateAvailable;
        }
      }
    }
  }

  return NextResponse.json({ installed, latest, updateAvailable, package: pkg.name });
}

async function verifyAuth(request: Request): Promise<boolean> {
  const raw = request.headers.get('cookie') || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith('olympus_token='));
  if (!match) return false;

  const cookieToken = decodeURIComponent(match.split('=')[1]);
  try {
    const secret = new TextEncoder().encode(
      process.env.OLYMPUS_JWT_SECRET || 'olympus-jwt-secret-change-in-prod',
    );
    await jwtVerify(cookieToken, secret);
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /api/update-check
 *
 * Spawns olympus update in background (non-blocking). The update writes
 * its output to ~/.config/olympus/data/update.log, then olympus restart
 * signals olympus serve to exit so systemd/Docker/pm2 restarts it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!(await verifyAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dataDir = process.env.OLYMPUS_DATA_DIR || join(process.env.HOME || '/root', '.config', 'olympus', 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const logPath = join(dataDir, 'update.log');
  appendFileSync(logPath, `=== Update started at ${new Date().toISOString()} ===\n`);

  // Spawn olympus update in background, then restart when done
  const out = require('fs').openSync(logPath, 'a');
  const child = spawn('/bin/bash', [
    '-c',
    'npm install -g @flame0510/olympus@latest && sleep 2 && olympus restart'
  ], {
    stdio: ['ignore', out, out],
    detached: true,
  });
  child.unref();

  return NextResponse.json({
    success: true,
    message: 'Update started. The dashboard will restart once complete.',
  });
}
