/**
 * Cookie flags for the session (`rev4a_token`) and the wizard marker, picked from the
 * scheme the requester's own browser shows in `Origin`.
 *
 * Browsers send `Origin` on every POST, same-origin included, and it carries the scheme
 * of the page, also behind a TLS-terminating proxy. The header decides only the flags of
 * the cookie that same requester receives, so a forged value can at most weaken the
 * requester's own cookie. Never read `X-Forwarded-Proto` or the protocol of `request.url`:
 * neither tells what the browser sees. `REV4A_FORCE_INSECURE_COOKIE` is not read any more.
 */

type HeaderSource = { headers: { get(name: string): string | null } };

/** Only clean HTTP(S) origins: no opaque origin, credentials or URL path (same rule as proxy.ts). */
function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict' | 'lax';
  path: '/';
  maxAge: number;
}

/** The scheme the browser shows in `Origin`, or null when it is absent, `null` or unusable. */
export function originProtocol(request: HeaderSource): 'http:' | 'https:' | null {
  const header = request.headers.get('origin');
  const origin = header === null ? null : parseOrigin(header);
  return origin ? (origin.protocol as 'http:' | 'https:') : null;
}

export function sessionCookieOptions(request: HeaderSource, { maxAge }: { maxAge: number }): SessionCookieOptions {
  if (process.env.NODE_ENV !== 'production') {
    return { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge };
  }
  // Plain HTTP only when the browser says so; anything unknown stays Secure + Strict.
  const plain = originProtocol(request) === 'http:';
  return { httpOnly: true, secure: !plain, sameSite: plain ? 'lax' : 'strict', path: '/', maxAge };
}
