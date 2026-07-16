/**
 * POST /api/wizard/complete
 *
 * Sets the wizard_done cookie to mark wizard as complete.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function POST(): NextResponse {
  const response = NextResponse.json({ done: true });
  response.cookies.set('wizard_done', '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365, // 1 year
    path: '/',
  });
  return response;
}
