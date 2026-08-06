import { Suspense } from 'react';
import DashboardLayout from './components/DashboardLayout';
import { Skeleton } from './components/Skeleton';

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
