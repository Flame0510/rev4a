'use client';

import { useRouter } from 'next/navigation';

/**
 * WizardButton
 *
 * Floating button (bottom-left) that opens the wizard.
 * The wizard is a full-screen experience — this button is just
 * a shortcut to revisit it after completion.
 *
 * The outer .floating-actions container handles positioning.
 */
export default function WizardButton() {
  const router = useRouter();

  return (
    <button
      className="ochat__trigger"
      aria-label="Wizard"
      title="Wizard"
      onClick={() => router.push('/wizard')}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z" />
      </svg>
      <span className="floating-actions__label">Wizard</span>
    </button>
  );
}
