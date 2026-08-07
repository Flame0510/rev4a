import { NextResponse, type NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import * as fs from 'fs';
import { ENV_FILE } from '@/lib/rev4a-paths';

// ---------------------------------------------------------------------------
// Resolve credentials at runtime from the persistent .env file.
// ---------------------------------------------------------------------------
function getEnvPassword(): string {
  const fromEnv = process.env.REV4A_PASSWORD;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  try {
    if (fs.existsSync(ENV_FILE)) {
      const content = fs.readFileSync(ENV_FILE, 'utf-8');
      const match = content.match(/^REV4A_PASSWORD=(.*)$/m);
      if (match && match[1].trim()) return match[1].trim();
    }
  } catch { /* ignore */ }
  return '';
}

function getEnvJwtSecret(): string {
  const fromEnv = process.env.REV4A_JWT_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  try {
    if (fs.existsSync(ENV_FILE)) {
      const content = fs.readFileSync(ENV_FILE, 'utf-8');
      const match = content.match(/^REV4A_JWT_SECRET=(.*)$/m);
      if (match && match[1].trim()) return match[1].trim();
    }
  } catch { /* ignore */ }
  return '';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const password = getEnvPassword();
    const jwtSecret = getEnvJwtSecret();

    if (!password) {
      console.error('[auth] No password configured — rejecting login');
      return NextResponse.json(
        { error: 'Server not configured. Run the setup wizard first.' },
        { status: 401 },
      );
    }

    if (!jwtSecret) {
      console.error('[auth] No JWT secret configured — rejecting login');
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

    // Use secure cookies only when running behind HTTPS.
    // On plain HTTP the Secure flag prevents the browser from sending
    // the cookie, causing an immediate redirect loop after login.
    const isProduction = process.env.NODE_ENV === 'production';
    const forceInsecure = process.env.REV4A_FORCE_INSECURE_COOKIE === '1';

    const response = NextResponse.json({ ok: true });
    response.cookies.set('rev4a_token', token, {
      httpOnly: true,
      secure: isProduction && !forceInsecure,
      sameSite: isProduction && !forceInsecure ? 'strict' : 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });
    return response;
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
