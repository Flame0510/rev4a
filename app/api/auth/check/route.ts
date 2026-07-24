import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import * as fs from 'fs';
import * as path from 'path';

function getJwtSecret(): Uint8Array {
  // Primary: process.env (inlined at build time from .env)
  const fromEnv = process.env.OLYMPUS_JWT_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return new TextEncoder().encode(fromEnv);
  }
  // Fallback: read .env file at runtime
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(/^OLYMPUS_JWT_SECRET=(.+)$/m)
      if (match && match[1].trim()) {
        return new TextEncoder().encode(match[1].trim());
      }
    }
  } catch { /* ignore */ }
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
