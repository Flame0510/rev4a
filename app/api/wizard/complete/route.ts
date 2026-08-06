/**
 * POST /api/wizard/complete
 *
 * Sets wizard as complete in a persistent file (cross-browser).
 * Also sets the httpOnly cookie for backwards compatibility.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { REV4A_DATA } from '@/lib/rev4a-paths';

export const dynamic = 'force-dynamic';

const WIZARD_FILE = REV4A_DATA + '/data/wizard.json';

export function POST(): NextResponse {
  // Write persistent marker
  const dir = path.dirname(WIZARD_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WIZARD_FILE, JSON.stringify({ done: true }, null, 2));

  const response = NextResponse.json({ done: true });
  // Also set cookie for backwards compat / existing clients
  response.cookies.set('wizard_done', '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
  });
  return response;
}
