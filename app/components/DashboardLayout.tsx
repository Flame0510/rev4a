'use client';

import { isWizardComplete } from '../wizard/storage';
import { useEffect, useState } from 'react';
import { useResponsive } from '../design-system';
import type { Costs } from '@/lib/types';
import { useDashboard } from '@/lib/hooks/useDashboard';
import { useScreenshot } from '@/lib/hooks/useScreenshot';
import DashboardHeader from './DashboardHeader';
import SystemCockpit from './SystemCockpit';
import SessionDrawer from './SessionDrawer';

interface DashboardLayoutProps {
  initialCosts?: Partial<Costs>;
}

export default function DashboardLayout({ initialCosts }: DashboardLayoutProps) {
  const {
    sessions,
    events,
    costs,
    selectedSessionId,
    selectSession,
    hasSessionsLoaded,
    hasCostLoaded,
  } = useDashboard({ initialCosts });

  const isMobile = useResponsive('md');
  const { loading: screenshotLoading, takeScreenshot } = useScreenshot();
  const [wizardBanner, setOnboardingBanner] = useState(false);

  useEffect(() => {
    const check = () => {
      setOnboardingBanner(!isWizardComplete());
    };
    check();

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.complete) setOnboardingBanner(false);
      else setOnboardingBanner(true);
    };
    window.addEventListener('wizard-step-changed', handler);
    return () => window.removeEventListener('wizard-step-changed', handler);
  }, []);

  return (
    <main className="shell">
      <DashboardHeader costs={costs} loading={!hasCostLoaded} hideLogo title="DASHBOARD" />
      {wizardBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 14px',
          background: 'rgba(212,155,53,0.08)',
          borderBottom: '1px solid rgba(212,155,53,0.2)',
          fontSize: 12, color: '#fbbf24',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span style={{ flex: 1 }}>
            Setup incomplete — <a href="/wizard" style={{ color: '#60a5fa', textDecoration: 'underline' }}>complete the wizard</a> to configure providers and create your first agent.
          </span>
          <button onClick={() => setOnboardingBanner(false)} aria-label="Dismiss" style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 14, padding: '0 6px' }}>✕</button>
        </div>
      )}
      {isMobile && (
        <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={takeScreenshot}
            disabled={screenshotLoading}
            title="Screenshot"
            style={{
              padding: '6px 10px',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
          </button>
        </div>
      )}

      <section className="layout layout--cockpit">
        <SystemCockpit sessions={sessions} events={events} costs={costs} loading={!hasSessionsLoaded} />
      </section>

      <SessionDrawer
        sessionId={selectedSessionId}
        onClose={() => selectSession(null)}
      />
    </main>
  );
}
