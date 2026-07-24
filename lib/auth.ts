import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { readToken, readJwtSecret } from '@/lib/env';

export async function requireBrowserAuth(request: NextRequest): Promise<NextResponse | null> {
  const TOKEN = readToken();
  const JWT_SECRET = readJwtSecret();

  const token = new URL(request.url).searchParams.get('token');
  const auth = request.headers.get('authorization');

  if (TOKEN && (token === TOKEN || auth === `Bearer ${TOKEN}`)) {
    return null;
  }

  const cookieToken = request.cookies.get('olympus_token')?.value;
  if (cookieToken && JWT_SECRET) {
    try {
      const key = new TextEncoder().encode(JWT_SECRET);
      await jwtVerify(cookieToken, key);
      return null;
    } catch {
      // Fall through to unauthorized.
    }
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
