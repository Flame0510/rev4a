import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { getJwtSecret } from '@/lib/rev4a-auth';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookieToken = request.cookies.get('rev4a_token')?.value;
  if (cookieToken) {
    try {
      const secret = new TextEncoder().encode(getJwtSecret());
      await jwtVerify(cookieToken, secret);
      return NextResponse.json({ authenticated: true });
    } catch {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }
  }
  return NextResponse.json({ authenticated: false }, { status: 401 });
}
