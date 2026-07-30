import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

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
        latest = execSync(
          'npm view @flame0510/olympus version --registry https://registry.npmjs.org 2>/dev/null',
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

/**
 * POST /api/update-check
 *
 * Runs npm install -g @flame0510/olympus@latest.
 * Protected by JWT cookie (olympus_token).
 */
export async function POST(request: Request): Promise<NextResponse> {
  // Auth: verify JWT cookie
  const raw = request.headers.get('cookie') || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith('olympus_token='));
  if (!match) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cookieToken = decodeURIComponent(match.split('=')[1]);
  try {
    const secret = new TextEncoder().encode(
      process.env.OLYMPUS_JWT_SECRET || 'olympus-jwt-secret-change-in-prod',
    );
    await jwtVerify(cookieToken, secret);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Run update
  try {
    const { execSync } = await import('child_process');
    const npmPath = process.env.NPM_PATH || 'npm';

    const update = execSync(`${npmPath} install -g @flame0510/olympus@latest 2>&1`, {
      stdio: 'pipe',
      timeout: 60_000,
    }).toString();

    const newPkg = execSync(`${npmPath} ls @flame0510/olympus --global --json --depth=0 2>/dev/null`, {
      stdio: 'pipe',
      timeout: 10_000,
    }).toString();

    let newVersion = '0.0.0';
    try {
      const parsed = JSON.parse(newPkg);
      newVersion = parsed.dependencies?.['@flame0510/olympus']?.version || '0.0.0';
    } catch {}

    // Bust cache
    cache = null;

    return NextResponse.json({
      success: true,
      oldVersion: pkg.version,
      newVersion,
      output: update.trim().split('\n').slice(-3).join('\n'),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.stderr?.toString() || err.message || 'Unknown error' },
      { status: 500 },
    );
  }
}
