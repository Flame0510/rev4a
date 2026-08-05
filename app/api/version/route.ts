import { NextResponse } from 'next/server';

let pkg: { version: string } = { version: '0.0.0' };
try {
  pkg = require('../../../package.json');
} catch {
  /* fallback */
}

export const dynamic = 'force-dynamic';

/**
 * GET /api/version
 *
 * Returns the installed Rev4a version from package.json.
 * No auth required.
 */
export function GET(): NextResponse {
  return NextResponse.json({
    version: pkg.version,
  });
}
