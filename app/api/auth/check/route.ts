import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import * as fs from 'fs';
import { ENV_FILE } from '@/lib/olympus-paths';

function getJwtSecret(): Uint8Array {
  const fromEnv = process.env.OLYMPUS_JWT_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return new TextEncoder().encode(fromEnv);
  }
  // Fallback: read from persistent .env
  for (const file of [ENV_FILE]) {
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf-8');
        const match = content.match(/^OLYMPUS_JWT_SECRET=(.*)$/m);
        if (match && match[1].trim()) {
          return new TextEncoder().encode(match[1].trim());
        }
      }
    } catch { /* ignore */ }
  }
  return new TextEncoder().encode('');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookieToken = request.cookies.get('olympus_token')?.value;
  if (cookieToken) {
    try {
      const secret = getJwtSecret();
      await jwtVerify(cookieToken, secret);
      return NextResponse.json({ authenticated: true });
    } catch {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }
  }
  return NextResponse.json({ authenticated: false }, { status: 401 });
}
