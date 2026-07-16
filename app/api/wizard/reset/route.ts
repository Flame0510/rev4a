/**
 * POST /api/wizard/reset
 *
 * Clears the wizard_done cookie so the wizard runs again.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function POST(): NextResponse {
  const response = NextResponse.json({ done: false });
  response.cookies.set('wizard_done', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0, // delete
    path: '/',
  });
  return response;
}
