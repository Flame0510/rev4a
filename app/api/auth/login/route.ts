import { NextResponse, type NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import * as fs from 'fs';
import * as path from 'path';

/**
 * POST /api/auth/login
 *
 * Validates the password and returns a signed JWT on success.
 * Reads credentials ONLY from .env on disk, never from process.env,
 * because Next.js inlines env vars at build time and the .env file
 * is created at runtime by the setup wizard.
 */

function readEnvValue(key: string): string {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return '';
    const content = fs.readFileSync(envPath, 'utf-8');
    const regex = new RegExp('^' + key + '=(.*)$', 'm');
    const match = content.match(regex);
    if (match && match[1].trim()) return match[1].trim();
  } catch {
    // ignore
  }
  return '';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const password = readEnvValue('OLYMPUS_PASSWORD');
    const jwtSecret = readEnvValue('OLYMPUS_JWT_SECRET');

    if (!password) {
      return NextResponse.json(
        { error: 'Server not configured. Run the setup wizard first.' },
        { status: 401 },
      );
    }

    if (!jwtSecret) {
      return NextResponse.json(
        { error: 'Server not configured. JWT secret missing.' },
        { status: 401 },
      );
    }

    const { password: input } = (await request.json()) as {
      password?: string;
    };

    if (!input || input !== password) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    const secretKey = new TextEncoder().encode(jwtSecret);
    const token = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secretKey);

    const response = NextResponse.json({ ok: true });
    response.cookies.set('olympus_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });
    return response;
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
