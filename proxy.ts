import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { join } from 'path';
import { getJwtSecret } from '@/lib/rev4a-auth';
import { REV4A_DATA } from '@/lib/rev4a-paths';
import { currentUpdate } from '@/lib/update-state';

/* ------------------------------------------------------------------ */
/*  Public routes — no auth required                                  */
/* ------------------------------------------------------------------ */
const PUBLIC_PREFIXES = ['/login', '/setup'];

/* ------------------------------------------------------------------ */
/*  Bypass — static assets and APIs have their own auth               */
/* ------------------------------------------------------------------ */
function isStaticOrApi(pathname: string): boolean {
  return (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/icon') ||
    pathname.startsWith('/apple-touch') ||
    pathname.startsWith('/rev4a-logo') ||
    pathname.startsWith('/manifest') ||
    pathname.includes('.') // file extensions (png, svg, ico, etc.)
  );
}

/* ------------------------------------------------------------------ */
/*  Update guard — one place every API request passes                  */
/*                                                                    */
/*  While `rev4a update` replaces files, rebuilds .next and restarts,  */
/*  the old server keeps answering. A write accepted in that window   */
/*  can be lost with the restart or run against half-replaced code,   */
/*  so mutating API calls answer 503 until the update ends. Done here */
/*  (not per route) because the proxy sees every request: a new route */
/*  is guarded without anyone remembering to. Page navigations and    */
/*  reads are untouched.                                              */
/* ------------------------------------------------------------------ */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Always allowed: sign-in/out, the update's own endpoints, and the agents' provider proxy. */
const UPDATE_EXEMPT_PREFIXES = ['/api/auth', '/api/update-check', '/api/update-status', '/api/provider'];
const UPDATE_STATE_DIR = join(REV4A_DATA, 'data');

function updateGuard(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;
  if (!(pathname === '/api' || pathname.startsWith('/api/')) || !MUTATING.has(request.method)) return null;
  if (UPDATE_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  let update;
  try {
    update = currentUpdate(UPDATE_STATE_DIR);
  } catch {
    return null; // an unreadable state must never lock the dashboard
  }
  if (!update) return null;
  return NextResponse.json({ error: 'Rev4a is updating', phase: update.phase }, { status: 503, headers: { 'Retry-After': '10' } });
}

/* ------------------------------------------------------------------ */
/*  Proxy (formerly middleware — Next.js 16 renamed the convention;   */
/*  runs on Node.js runtime by default now, so it shares the same     */
/*  env+file secret resolution as every API route instead of its own */
/*  env-only copy.)                                                    */
/* ------------------------------------------------------------------ */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const blocked = updateGuard(request);
  if (blocked) return blocked;

  // Public routes
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Static assets & API routes
  if (isStaticOrApi(pathname)) {
    return NextResponse.next();
  }

  // Protected route — verify JWT
  const token = request.cookies.get('rev4a_token')?.value;
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  try {
    const secret = new TextEncoder().encode(getJwtSecret());
    await jwtVerify(token, secret);
    return NextResponse.next();
  } catch {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }
}

/* ------------------------------------------------------------------ */
/*  Matcher — page routes and /api/* (the update guard needs the API), skip Next.js internals */
/* ------------------------------------------------------------------ */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
