/**
 * GET /api/auth/status
 *
 * Public endpoint — no auth required.
 * Returns whether Olympus is fully configured (password set) or in setup mode.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  const password = process.env.OLYMPUS_PASSWORD;
  const configured = typeof password === 'string' && password.length > 0;
  return NextResponse.json({ configured });
}
