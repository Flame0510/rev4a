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
      fetch('/api/auth/status')
        .then((r) => r.json())
        .then((d: { configured: boolean }) => {
          if (!d.configured) router.replace('/setup');
          setChecking(false);
        })
        .catch(() => setChecking(false));
      return;
    }

    // Protected routes — check auth
    fetch('/api/auth/check')
      .then(async (r) => {
        if (!r.ok) {
          const status = await fetch('/api/auth/status').then((r2) => r2.json());
          router.replace(status.configured ? '/login' : '/setup');
          return;
        }

        // Authenticated — redirect to wizard only if both conditions met
        if (pathname === '/wizard') {
          setChecking(false);
          return;
        }

        const [statusRes, wizardRes] = await Promise.all([
          fetch('/api/auth/status'),
          fetch('/api/wizard/status'),
        ]);
        const { configured } = await statusRes.json();
        const { done: wizardDone } = await wizardRes.json();

        if (!configured && !wizardDone) {
          router.replace('/wizard');
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
