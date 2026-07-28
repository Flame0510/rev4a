import { NextResponse } from 'next/server';

let pkg;
try {
  pkg = require('../../../package.json');
} catch {
  pkg = { version: '0.0.0', name: '@flame0510/olympus' };
}

/**
 * GET /api/version
 *
 * Returns the installed version. If the caller passes ?check=1,
 * it also queries the registry for the latest version.
 * No auth required.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const check = url.searchParams.get('check') === '1';

  const installed = pkg.version || '0.0.0';
  let latest: string | null = null;
  let updateAvailable = false;

  if (check) {
    try {
      const { execSync } = await import('child_process');
      latest = execSync(
        'npm view @flame0510/olympus version --registry https://npm.pkg.github.com 2>/dev/null',
        { stdio: 'pipe', timeout: 10_000 },
      )
        .toString()
        .trim();

      if (latest && latest !== installed) {
        updateAvailable = true;
      }
    } catch {
      // registry unreachable — skip
    }
  }

  return NextResponse.json({
    installed,
    latest,
    updateAvailable,
    package: pkg.name,
  });
}
