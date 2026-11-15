/**
 * POST /api/wizard/complete
 *
 * Sets wizard as complete in a persistent file (cross-browser).
 * Also sets the httpOnly cookie for backwards compatibility.
 */
import { NextResponse, type NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { REV4A_DATA } from '@/lib/rev4a-paths';
import { requireAuthIfConfigured } from '@/lib/rev4a-auth';
import { sessionCookieOptions } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

const WIZARD_FILE = path.join(REV4A_DATA, 'data', 'wizard.json');

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthIfConfigured(request);
  if (denied) return denied;

  // Write persistent marker
  const dir = path.dirname(WIZARD_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WIZARD_FILE, JSON.stringify({ done: true }, null, 2));

  const response = NextResponse.json({ done: true });
  // Also set cookie for backwards compat / existing clients
  response.cookies.set('wizard_done', '1', sessionCookieOptions(request, { maxAge: 60 * 60 * 24 * 365 }));
  return response;
}
