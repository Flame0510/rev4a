import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { getJwtSecret, getPassword, passwordFingerprint, fingerprintEquals } from '@/lib/rev4a-auth';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookieToken = request.cookies.get('rev4a_token')?.value;
  if (cookieToken) {
    try {
      const jwtSecret = getJwtSecret();
      const secret = new TextEncoder().encode(jwtSecret);
      const { payload } = await jwtVerify(cookieToken, secret);
      const password = getPassword();
      if (password && fingerprintEquals(payload.pwf, passwordFingerprint(password, jwtSecret))) {
        return NextResponse.json({ authenticated: true });
      }
    } catch {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }
  }
  return NextResponse.json({ authenticated: false }, { status: 401 });
}
