import { NextResponse } from 'next/server';

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
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * GET /api/update-check
 *
 * Returns the installed version. If the caller passes ?check=1,
 * it queries the npm registry for the latest version (cached 15 min).
 * No auth required — shields behind server-side caching.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const check = url.searchParams.get('check') === '1';

  const installed = pkg.version || '0.0.0';
  let latest: string | null = null;
  let updateAvailable = false;

  if (check) {
    const now = Date.now();
    if (cache && (now - cache.checkedAt) < CACHE_TTL_MS) {
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
        // registry unreachable — reuse stale cache if available
        if (cache) {
          latest = cache.latest;
          updateAvailable = cache.updateAvailable;
        }
      }
    }
  }

  return NextResponse.json({
    installed,
    latest,
    updateAvailable,
    package: pkg.name,
  });
}
