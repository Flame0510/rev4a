'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';

// Cache auth result per session to avoid re-checking on every navigation
const authCache = { valid: false, checked: false, ts: 0 };
const AUTH_CACHE_TTL = 30_000; // 30s before re-check

function isCacheValid(): boolean {
  return authCache.checked && authCache.valid && (Date.now() - authCache.ts) < AUTH_CACHE_TTL;
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [redirecting, setRedirecting] = useState(false);
  const checkingRef = useRef(false);

  // Which pathname the last successful check applies to. Kept per-path so a
  // client-side navigation to a different protected route can't inherit the
  // previous route's "verified" state and flash its content for a frame.
  const [verifiedPath, setVerifiedPath] = useState<string | null>(null);

  const isPublicRoute = pathname === '/setup' || pathname === '/login';
  // Evaluated fresh on every render (not held in state), so an expired cache
  // closes the gate immediately rather than one paint late.
  const ready = isPublicRoute || isCacheValid() || verifiedPath === pathname;

  useEffect(() => {
    // A redirect that has landed is finished: clear the flag on every
    // navigation, otherwise the render gate below stays closed forever and
    // the destination page renders blank. (AppShell currently unmounts this
    // component for /login, /setup and /wizard, which used to hide the bug —
    // don't depend on that staying true.)
    setRedirecting(false);

    // /setup: always accessible
    if (pathname === '/setup') return;

    // /login: public, but bounce to /setup if no password exists yet
    if (pathname === '/login') {
      fetch('/api/auth/status')
        .then((r) => r.json())
        .then((d: { configured: boolean }) => {
          if (!d.configured) router.replace('/setup');
        })
        .catch(() => {});
      return;
    }

    // Already checking — prevent duplicate
    if (checkingRef.current) return;

    // Cache hit — content is already known-good, `ready` above covers it
    if (isCacheValid()) return;

    checkingRef.current = true;

    // Protected route with no valid cache — verify before revealing content
    fetch('/api/auth/check')
      .then(async (r) => {
        if (!r.ok) {
          // Not authenticated — redirect, keep content hidden
          authCache.valid = false;
          authCache.checked = true;
          const status = await fetch('/api/auth/status').then((r2) => r2.json());
          setRedirecting(true);
          router.replace(status.configured ? '/login' : '/setup');
          return;
        }

        // Auth valid
        authCache.valid = true;
        authCache.checked = true;
        authCache.ts = Date.now();
        setVerifiedPath(pathname);

        if (pathname === '/wizard') return;

        // Check wizard status
        const [statusRes, wizardRes] = await Promise.all([
          fetch('/api/auth/status'),
          fetch('/api/wizard/status'),
        ]);
        const { configured } = await statusRes.json();
        const { done: wizardDone } = await wizardRes.json();

        if (!configured && !wizardDone) {
          setRedirecting(true);
          router.replace('/wizard');
        }
      })
      .catch(async () => {
        try {
          const status = await fetch('/api/auth/status').then((r) => r.json());
          setRedirecting(true);
          router.replace(status.configured ? '/login' : '/setup');
        } catch {
          setRedirecting(true);
          router.replace('/login');
        }
      })
      .finally(() => {
        checkingRef.current = false;
      });
  }, [pathname, router]);

  if (redirecting) return null;
  if (!ready) return null; // hold content until this route's check resolves
  return <>{children}</>;
}
