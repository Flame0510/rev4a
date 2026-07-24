import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import * as fs from 'fs';
import * as path from 'path';

/**
 * GET /api/auth/check
 *
 * Validates the olympus_token JWT cookie.
 * Reads JWT secret from .env on disk — same reasoning as login route.
 */

function readJwtSecret(): string {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return '';
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(/^OLYMPUS_JWT_SECRET=(.*)$/m);
    if (match && match[1].trim()) return match[1].trim();
  } catch {
    // ignore
  }
  return '';
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookieToken = request.cookies.get('olympus_token')?.value;
  if (!cookieToken) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const secret = readJwtSecret();
  if (!secret) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  try {
    const secretKey = new TextEncoder().encode(secret);
    await jwtVerify(cookieToken, secretKey);
    return NextResponse.json({ authenticated: true });
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
}
