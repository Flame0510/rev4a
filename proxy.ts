import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { getJwtSecret } from '@/lib/rev4a-auth';

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
/*  Proxy (formerly middleware — Next.js 16 renamed the convention;   */
/*  runs on Node.js runtime by default now, so it shares the same     */
/*  env+file secret resolution as every API route instead of its own */
/*  env-only copy.)                                                    */
/* ------------------------------------------------------------------ */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
/*  Matcher — only run on page routes, skip Next.js internals         */
/* ------------------------------------------------------------------ */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
