import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const JWT_SECRET = (() => {
  const s = process.env.OLYMPUS_JWT_SECRET;
  if (!s) throw new Error('OLYMPUS_JWT_SECRET is required');
  return new TextEncoder().encode(s);
})();

const TOKEN = (() => {
  const t = process.env.OLYMPUS_TOKEN;
  if (!t) throw new Error('OLYMPUS_TOKEN is required');
  return t;
})();

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check if password is configured — if not, force /setup wizard
  const hasPassword = typeof process.env.OLYMPUS_PASSWORD === 'string' && process.env.OLYMPUS_PASSWORD.length > 0;

  // Public paths — no auth required
  // FIXME: /api/setup/* endpoints are fully public (no auth, no rate limit).
  // Add rate limiting before production exposure to prevent brute-force/DoS.
  if (
    pathname === '/login' ||
    pathname === '/setup' ||
    pathname === '/api/auth/login' ||
    pathname === '/api/auth/check' ||
    pathname === '/api/auth/status' ||
    pathname.startsWith('/api/setup/') ||
    pathname.startsWith('/api/wizard/') ||
    pathname === '/api/version' ||
    pathname.startsWith('/api/models') ||
    pathname === '/api/agents-config' ||
    pathname === '/api/agents/image-status' ||
    pathname === '/api/agents/download-image' ||
    pathname.startsWith('/api/provider/v1/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/icon-') ||
    pathname === '/manifest.json'
  ) {
    // If no password configured and user is on /login, redirect to /setup
    if (!hasPassword && pathname === '/login') {
      const setupUrl = request.nextUrl.clone();
      setupUrl.pathname = '/setup';
      return NextResponse.redirect(setupUrl);
    }
    return NextResponse.next();
  }

  // If no password configured, redirect everything else to /setup
  if (!hasPassword) {
    const setupUrl = request.nextUrl.clone();
    setupUrl.pathname = '/setup';
    return NextResponse.redirect(setupUrl);
  }

  // 1. Check query param token
  const qpToken = request.nextUrl.searchParams.get('token');
  if (qpToken === TOKEN) return NextResponse.next();

  // 2. Check Authorization header (Bearer token)
  const auth = request.headers.get('authorization');
  if (auth === `Bearer ${TOKEN}`) return NextResponse.next();

  // 2b. Check X-Agent-Token header (for internal agent-to-gateway calls)
  const agentToken = request.headers.get('x-agent-token');
  if (agentToken === TOKEN) return NextResponse.next();

  // 3. Check JWT cookie
  const cookieToken = request.cookies.get('olympus_token')?.value;
  if (cookieToken) {
    try {
      await jwtVerify(cookieToken, JWT_SECRET);
      return NextResponse.next();
    } catch {
      // Invalid JWT — fall through to redirect
    }
  }

  // For API routes: return 401 JSON
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // For pages: redirect to /login
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.svg|icon-192.png|icon-512.png|manifest.json).*)'],
};
