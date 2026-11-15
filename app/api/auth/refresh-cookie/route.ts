/**
 * POST /api/auth/refresh-cookie
 *
 * Upgrades a session cookie made over plain HTTP once the browser is on HTTPS: the same
 * JWT is set again as Secure + Strict. Nothing else changes: no new token, no new
 * fingerprint, and never a longer life than the token already has.
 *
 * Only an `https:` Origin triggers it (see `lib/session-cookie.ts`); on any other answer
 * the route changes nothing and replies 204. The origin guard covers it like any other
 * cookie-authenticated write.
 *
 * A request that carries `Authorization` is left alone: `requireAuthJWT` may have accepted the
 * bearer token instead of the cookie, and an unverified cookie is never copied. Without it the
 * cookie itself passed `jwtVerify` and the fingerprint check, so its `exp` can be trusted.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { decodeJwt } from 'jose';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { originProtocol, sessionCookieOptions } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
/** The session's own lifetime (login sets 7 days): an upgrade never outlives it. */
const MAX_AGE = 60 * 60 * 24 * 7;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied as NextResponse;

  const token = request.cookies.get('rev4a_token')?.value;
  const options = sessionCookieOptions(request, { maxAge: 0 });
  if (!token || request.headers.has('authorization') || originProtocol(request) !== 'https:' || !options.secure) {
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  }

  let exp: number | undefined;
  try { exp = decodeJwt(token).exp; } catch { /* unreadable: leave the cookie alone */ }
  const left = typeof exp === 'number' && Number.isFinite(exp) ? Math.min(MAX_AGE, Math.floor(exp - Date.now() / 1000)) : 0;
  if (left <= 0) return new NextResponse(null, { status: 204, headers: NO_STORE });

  const response = new NextResponse(null, { status: 204, headers: NO_STORE });
  response.cookies.set('rev4a_token', token, { ...options, maxAge: left });
  return response;
}
