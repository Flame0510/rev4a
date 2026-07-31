import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { execSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

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

function getRoot(): string {
  return process.env.OLYMPUS_ROOT || process.cwd();
}

function getDataDir(): string {
  return process.env.OLYMPUS_DATA_DIR || join(getRoot(), 'data');
}

function getUpdateCommand(): string | null {
  return process.env.OLYMPUS_UPDATE_COMMAND || null;
}

function getDefaultUpdateCommand(): string {
  const root = getRoot();
  const pkgName = pkg.name || '@flame0510/olympus';
  const isGitRepo = existsSync(join(root, '.git'));

  if (isGitRepo) {
    return `cd ${root} && git pull && npm install && npm run build`;
  }
  return `npm install -g ${pkgName}@latest`;
}

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
 * Runs the update synchronously (blocking), then writes .restart-flag.
 * The olympus serve process watches for this flag and does cleanup() + exit().
 * With systemd Restart=always (or Docker/pm2), it restarts automatically.
 * For bare node installs, we also attempt a direct restart via spawn.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!(await verifyAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const root = getRoot();
  const updateCmd = getUpdateCommand() || getDefaultUpdateCommand();

  // Run the update synchronously then restart
  const restartFlag = join(getDataDir(), '.restart-flag');

  let updateOutput = '';
  try {
    updateOutput = execSync(updateCmd, {
      stdio: 'pipe',
      timeout: 120_000,
      cwd: root,
      encoding: 'utf-8',
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.stderr?.toString() || err.message || 'Update command failed' },
      { status: 500 },
    );
  }

  // Signal restart via flag — olympus serve watches for this
  try { writeFileSync(restartFlag, ''); } catch {}

  return NextResponse.json({
    success: true,
    oldVersion: pkg.version,
    message: 'Update complete. The dashboard will restart.',
    output: updateOutput.trim().split('\n').slice(-3).join('\n'),
  });
}
