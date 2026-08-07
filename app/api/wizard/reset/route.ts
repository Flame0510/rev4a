/**
 * POST /api/wizard/reset
 *
 * Clears the wizard marker so the wizard runs again.
 * Removes both the persistent file and the cookie.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import { REV4A_DATA } from '@/lib/rev4a-paths';

export const dynamic = 'force-dynamic';

const WIZARD_FILE = REV4A_DATA + '/data/wizard.json';

export function POST(): NextResponse {
  // Remove persistent marker
  try { fs.unlinkSync(WIZARD_FILE); } catch { /* ignore */ }

  const response = NextResponse.json({ done: false });
  const isProduction = process.env.NODE_ENV === 'production';
  const forceInsecure = process.env.REV4A_FORCE_INSECURE_COOKIE === '1';

  response.cookies.set('wizard_done', '', {
    httpOnly: true,
    secure: isProduction && !forceInsecure,
    sameSite: isProduction && !forceInsecure ? 'strict' : 'lax',
    maxAge: 0,
    path: '/',
  });
  return response;
}
