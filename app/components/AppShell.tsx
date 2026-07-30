'use client';

import { usePathname } from 'next/navigation';
import AuthGuard from './AuthGuard';
import Sidebar from './Sidebar';
import FloatingActions from './FloatingActions';
import UpdateBanner from './UpdateBanner';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin = pathname === '/login';
  const isSetup = pathname === '/setup';
  const isWizard = pathname === '/wizard';

  if (isLogin || isSetup || isWizard) {
    return <>{children}</>;
  }

  return (
    <AuthGuard>
      <div className="app-shell">
        <Sidebar />
        <main className="app-shell__content">{children}</main>
        <FloatingActions />
        <UpdateBanner />
      </div>
    </AuthGuard>
  );
}
