'use client';

import { usePathname } from 'next/navigation';
import PulseChat from './PulseChat';
import WizardButton from './WizardButton';

/**
 * FloatingActions
 *
 * Single container wrapping both floating buttons:
 * - WizardButton (left)
 * - PulseChat (right)
 *
 * Hidden on login, setup, and /wizard full-page.
 */
export default function FloatingActions() {
  const pathname = usePathname();

  if (pathname === '/login' || pathname === '/setup' || pathname === '/wizard') {
    return null;
  }

  return (
    <div className="floating-actions">
      <div className="floating-actions__left">
        <WizardButton />
      </div>
      <div className="floating-actions__right">
        <PulseChat />
      </div>
    </div>
  );
}
