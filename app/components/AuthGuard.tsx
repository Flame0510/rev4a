'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // /setup is always accessible (no auth, no redirect)
    if (pathname === '/setup') {
      setChecking(false);
      return;
    }

    // /login is public
    if (pathname === '/login') {
      // But if no password is configured, redirect to /setup
      fetch('/api/auth/status')
        .then((r) => r.json())
        .then((d: { configured: boolean }) => {
          if (!d.configured) {
            router.replace('/setup');
          }
          setChecking(false);
        })
        .catch(() => setChecking(false));
      return;
    }

    // Protected routes — check auth
    fetch('/api/auth/check')
      .then((r) => {
        if (!r.ok) {
          // Not authenticated — check if setup is needed
          return fetch('/api/auth/status').then((r2) => r2.json()).then((d: { configured: boolean }) => {
            if (!d.configured) {
              router.replace('/setup');
            } else {
              router.replace('/login');
            }
          });
        }
        // Authenticated — only redirect to wizard if not already on /wizard
        // AND password is not configured (fresh install)
        if (pathname !== '/wizard') {
          fetch('/api/auth/status')
            .then((r3) => r3.json())
            .then((d3: { configured: boolean }) => {
              if (!d3.configured) {
                router.replace('/wizard');
              }
              setChecking(false);
            })
            .catch(() => setChecking(false));
          return;
        }
        setChecking(false);
      })
      .catch(() => {
        router.replace('/login');
        setChecking(false);
      });
  }, [pathname, router]);

  if (checking && pathname !== '/setup') return null;

  return <>{children}</>;
}
