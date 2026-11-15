import { NextResponse, type NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { getPassword, getJwtSecret, secretEquals, passwordFingerprint } from '@/lib/rev4a-auth';
import { createLoginThrottle } from '@/lib/login-throttle';
import { CLIENT_IP_HEADER } from '@/lib/client-address';
import { sessionCookieOptions } from '@/lib/session-cookie';

// One throttle per server process: 5 free failures per hour, then growing locks (30 s up to 15 min).
const throttle = createLoginThrottle();

function humanWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const m = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return rest ? `${m} ${rest} second${rest === 1 ? '' : 's'}` : m;
}

function lockedResponse(retryAfterS: number): NextResponse {
  return NextResponse.json(
    { error: `Too many failed attempts. Try again in ${humanWait(retryAfterS)}.` },
    { status: 429, headers: { 'Retry-After': String(retryAfterS) } },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Set by server.js from the socket (and a trusted proxy's X-Forwarded-For); absent under `next dev`.
  const key = request.headers.get(CLIENT_IP_HEADER) || 'unknown';
  // Early check: a locked client's body is never read.
  const gate = throttle.check(key);
  if (!gate.allowed) return lockedResponse(gate.retryAfterS);

  try {
    const password = getPassword();
    const jwtSecret = getJwtSecret();

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

    let input: string | undefined;
    try {
      ({ password: input } = (await request.json()) as { password?: string });
    } catch (err) {
      throttle.fail(key); // an unreadable body is still an attempt
      throw err;
    }

    // Checked again after the await: requests sent in parallel all passed the early check
    // before any of them failed. Check, compare and fail now run in the same tick, so a
    // burst is cut off at the same failure as a sequence: the 6th wrong password sets the lock.
    const recheck = throttle.check(key);
    if (!recheck.allowed) return lockedResponse(recheck.retryAfterS);

    if (!input || !secretEquals(input, password)) {
      throttle.fail(key);
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    throttle.succeed(key);
    const secretKey = new TextEncoder().encode(jwtSecret);
    const token = await new SignJWT({ role: 'admin', pwf: passwordFingerprint(password, jwtSecret) })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secretKey);

    // Secure + Strict unless the browser itself is on plain HTTP (its Origin says so): on plain
    // HTTP the Secure flag would keep the browser from sending the cookie and login would loop.
    const response = NextResponse.json({ ok: true });
    response.cookies.set('rev4a_token', token, sessionCookieOptions(request, { maxAge: 60 * 60 * 24 * 7 }));
    return response;
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
