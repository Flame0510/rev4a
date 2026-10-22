import { Suspense } from 'react';
import DashboardLayout from './components/DashboardLayout';
import { Skeleton } from './components/Skeleton';
import type { Metadata } from 'next';

// The root layout's title template does not apply to a page in its own segment: spell it out.
export const metadata: Metadata = { title: { absolute: 'Dashboard · Rev4a' } };

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardLayout initialCosts={{ today: 0, allTime: 0, byModel: [] }} />
    </Suspense>
  );
}

function DashboardSkeleton() {
  return (
    <main className="shell">
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <Skeleton width={120} height={20} accent />
      </div>
      <section className="layout layout--cockpit">
        <div style={{ padding: 16, display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            {[1, 2, 3].map(i => <Skeleton key={i} height={80} />)}
          </div>
          <Skeleton height={120} />
        </div>
      </section>
    </main>
  );
}
