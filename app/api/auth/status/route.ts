import { NextResponse } from 'next/server';
import { isConfigured } from '@/lib/rev4a-auth';

/**
 * GET /api/auth/status
 *
 * Returns { configured: true } if a password has been set (either
 * in the environment or in the .env file created by the setup wizard).
 * No auth required — used by the frontend to decide whether to show
 * the setup wizard or the login form.
 */
export function GET(): NextResponse {
  return NextResponse.json({ configured: isConfigured() });
}
