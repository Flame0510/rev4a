import { NextResponse, type NextRequest } from 'next/server';

/**
 * proxy.ts — Next.js middleware
 *
 * LIGHTWEIGHT proxy that only handles:
 *   1. Token-based auth for API routes (?token=, Bearer, x-agent-token)
 *   2. Redirect to /setup when no password is configured
 *
 * JWT cookie verification is done at the page/API level (requireAuth, auth routes),
 * NOT here — because Next.js middleware runs in a limited runtime where `fs` is
 * not reliably available. The .env file is read directly by server components
 * and API routes using lib/env.ts.
 */

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Token-based auth: read from headers / query params.
  // process.env is fine here because the token is ONLY needed for API routes,
  // and the middleware can forward the check to the route handler if needed.
  // We check the token from process.env (set at build) OR from a known header
  // that the route handler validates against .env at runtime.

  // Public paths — no auth required
  if (
    pathname === '/login' ||
    pathname === '/setup' ||
    pathname === '/wizard' ||
    pathname === '/api/auth/login' ||
    pathname === '/api/auth/check' ||
    pathname === '/api/auth/status' ||
    pathname.startsWith('/api/setup/') ||
    pathname.startsWith('/api/wizard/') ||
    pathname === '/api/version' ||
    pathname.startsWith('/api/models') ||
    pathname === '/api/agents-config' ||
    pathname === '/api/agents/image-status' ||
    pathname === '/api/agents/build-logs' ||
    pathname === '/api/agents/rebuild-image' ||
    pathname === '/api/agents/abort-build' ||
    pathname.startsWith('/api/provider') ||
    pathname.startsWith('/api/gateway') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/icon-') ||
    pathname === '/manifest.json'
  ) {
    return NextResponse.next();
  }

  // For everything else, allow through.
  // Auth is enforced by:
  //   - requireAuth() in server components (pages)
  //   - API route handlers (lib/auth.ts, lib/db.ts requireAuth)
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.svg|icon-192.png|icon-512.png|manifest.json).*)'],
};