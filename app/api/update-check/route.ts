import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
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

/**
 * Builds the default update command chain.
 * Uses env vars so it's never tied to a specific user or service name.
 */
function getDefaultUpdateCommand(): string {
  const root = getRoot();
  const pkgName = pkg.name || '@flame0510/olympus';
  const isGitRepo = existsSync(join(root, '.git'));

  if (isGitRepo) {
    return `cd ${root} && git pull && npm install && npm run build`;
  }
  // npm global install path
  return `npm install -g ${pkgName}@latest`;
}

/**
 * GET /api/update-check
 *
 * Returns installed version. With ?check=1 it queries npm registry (cached 15 min).
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
        const { execSync } = await import('child_process');
        const pkgName = pkg.name || '@flame0510/olympus';
        latest = execSync(
          `npm view ${pkgName} version --registry https://registry.npmjs.org 2>/dev/null`,
          { stdio: 'pipe', timeout: 10_000 },
        )
          .toString()
          .trim();

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
 * Runs the update command (configurable via OLYMPUS_UPDATE_COMMAND),
 * then signals the olympus process to restart via .restart-flag.
 *
 * Protected by JWT cookie (olympus_token).
 * The update runs in a detached background process so the response
 * is sent before the restart kills the server.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!(await verifyAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const root = getRoot();
  const dataDir = getDataDir();
  const updateCmd = getUpdateCommand() || getDefaultUpdateCommand();

  try {
    const { spawn } = await import('child_process');

    // The restart flag is watched by olympus serve (bin/olympus.js).
    // When present, the parent process does cleanup() + process.exit(0).
    // systemd (Restart=always) or Docker/podman/pm2 then restarts the service.
    const restartFlag = join(dataDir, '.restart-flag');

    // Chain: run update command, then touch restart flag.
    // The restart flag must be written AFTER the build completes,
    // otherwise the server restarts before the new code is built.
    const cmd = `${updateCmd} && touch ${restartFlag}`;

    spawn('bash', ['-c', cmd], {
      detached: true,
      stdio: 'ignore',
      cwd: root,
    }).unref();

    return NextResponse.json({
      success: true,
      oldVersion: pkg.version,
      message: 'Update started. The dashboard will restart in a few seconds.',
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.stderr?.toString() || err.message || 'Unknown error' },
      { status: 500 },
    );
  }
}
