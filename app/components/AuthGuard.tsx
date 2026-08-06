'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';

// Cache auth result per session to avoid re-checking on every navigation
const authCache = { valid: false, checked: false, ts: 0 };
const AUTH_CACHE_TTL = 30_000; // 30s before re-check

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [redirecting, setRedirecting] = useState(false);
  const checkingRef = useRef(false);

  useEffect(() => {
    // /setup: always accessible
    if (pathname === '/setup') return;

    // /login: public, check if already authenticated
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

    // Cache hit — skip check
    if (authCache.checked && authCache.valid && (Date.now() - authCache.ts) < AUTH_CACHE_TTL) {
      return; // Still valid, no re-check
    }

    checkingRef.current = true;

    // Protected routes — check auth in background
    fetch('/api/auth/check')
      .then(async (r) => {
        if (!r.ok) {
          // Not authenticated — redirect
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

  // NEVER hide children — always render, auth check happens in background
  return <>{children}</>;
}
