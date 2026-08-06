import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';

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
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  return NextResponse.json({
    version: pkg.version,
  });
}
