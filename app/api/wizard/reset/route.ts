/**
 * POST /api/wizard/reset
 *
 * Clears the wizard marker so the wizard runs again.
 * Removes both the persistent file and the cookie.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import { OLYMPUS_DATA } from '@/lib/olympus-paths';

export const dynamic = 'force-dynamic';

const WIZARD_FILE = OLYMPUS_DATA + '/data/wizard.json';

export function POST(): NextResponse {
  // Remove persistent marker
  try { fs.unlinkSync(WIZARD_FILE); } catch { /* ignore */ }

  const response = NextResponse.json({ done: false });
  response.cookies.set('wizard_done', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  return response;
}
