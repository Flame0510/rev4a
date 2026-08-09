import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { requireAuthJWT } from '@/lib/rev4a-auth';

// Fallback used only when package.json cannot be read — the published npm
// package name is the single source of truth, so never hardcode it elsewhere.
const FALLBACK_PKG_NAME = '@flame0510/project-aether';

function getPackageInfo() {
  try {
    // Resolve relative to the project root (two levels above .next)
    const pkgPath = join(process.cwd(), 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: '0.0.0', name: FALLBACK_PKG_NAME };
  }
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
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  const url = new URL(request.url);
  const check = url.searchParams.get('check') === '1';

  const pkg = getPackageInfo();
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
        const pkgName = pkg.name || FALLBACK_PKG_NAME;
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

  return NextResponse.json({ installed, latest, updateAvailable, package: getPackageInfo().name });
}

async function verifyAuth(request: Request): Promise<boolean> {
  const raw = request.headers.get('cookie') || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith('rev4a_token='));
  if (!match) return false;

  const cookieToken = decodeURIComponent(match.split('=')[1]);
  try {
    const secret = new TextEncoder().encode(
      process.env.REV4A_JWT_SECRET || (() => { throw new Error('REV4A_JWT_SECRET not set'); })(),
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
 * Spawns rev4a update as a detached background process.
 * rev4a update installs the latest version and writes .restart-flag,
 * which rev4a serve detects and exits with code 42, then auto-restarts
 * with the newly installed binary. No systemd required.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  if (!(await verifyAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Spawn rev4a update in background, then write restart flag directly
  // from this process so rev4a serve detects it and restarts.
  const { spawn } = require('child_process');
  const { join } = require('path');
  const { writeFileSync } = require('fs');

  const dataDir = process.env.REV4A_DATA_DIR ||
    join(process.env.HOME || '/root', '.config', 'rev4a', 'data');

  const child = spawn('rev4a', ['update'], {
    stdio: 'ignore',
    detached: true,
  });

  // When rev4a update finishes, write the restart flag so rev4a serve
  // picks it up and exits with code 42, triggering the auto-restart loop.
  child.on('exit', () => {
    try { writeFileSync(join(dataDir, '.restart-flag'), ''); } catch {}
  });

  child.unref();

  return NextResponse.json({
    success: true,
    message: 'Update started. The dashboard will restart once complete.',
  });
}
