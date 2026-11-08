import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { join } from 'path';
import { getJwtSecret, getPassword, passwordFingerprint, fingerprintEquals } from '@/lib/rev4a-auth';
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

/** Only HTTP(S) origins, never opaque origins, credentials or URL paths. */
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

/** Cookie-authenticated browser writes must come from the dashboard itself. */
function originGuard(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;
  if (!(pathname === '/api' || pathname.startsWith('/api/')) || !MUTATING.has(request.method) ||
      !request.cookies.has('rev4a_token') || request.headers.has('authorization')) return null;

  const originHeader = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  // The browser computes Sec-Fetch-Site from the real page and target URLs, so it stays
  // right behind a reverse proxy that rewrites Host (nginx does by default), and a page on
  // another site cannot forge it. Every current browser sends it.
  if (site === 'same-origin' && originHeader !== 'null') return null;
  let allowed: boolean;
  if (originHeader !== null) {
    const origin = parseOrigin(originHeader);
    const host = request.headers.get('host');
    // Normalize both authorities using the Origin scheme so explicit :80/:443
    // match their implicit defaults, while other ports remain significant.
    const addressedOrigin = origin && host ? parseOrigin(`${origin.protocol}//${host}`) : null;
    // Forwarded headers alone never grant trust; a rewritten Host needs an allowlist.
    allowed = origin !== null && (
      origin.host.toLowerCase() === addressedOrigin?.host.toLowerCase() ||
      (process.env.REV4A_ALLOWED_ORIGINS || '').split(',').some((entry) =>
        parseOrigin(entry.trim())?.origin === origin.origin)
    );
  } else {
    allowed = site !== 'cross-site' && site !== 'same-site';
  }
  return allowed ? null : NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
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

  const crossSite = originGuard(request);
  if (crossSite) return crossSite;

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
    const jwtSecret = getJwtSecret();
    const secret = new TextEncoder().encode(jwtSecret);
    const { payload } = await jwtVerify(token, secret);
    const password = getPassword();
    if (!password || !fingerprintEquals(payload.pwf, passwordFingerprint(password, jwtSecret))) {
      throw new Error('Invalid session');
    }
    return NextResponse.next();
  } catch {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }
}

/* ------------------------------------------------------------------ */
/*  Matcher — page routes and /api/* (update and origin guards), skip Next.js internals */
/* ------------------------------------------------------------------ */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
