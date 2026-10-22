import { Suspense } from 'react';
import LineageGraphPage from '../components/LineageGraphPage';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Lineage' };

export const dynamic = 'force-dynamic';

export default function LineagePage() {

  return (
    <Suspense>
      <LineageGraphPage initialCosts={{ today: 0, allTime: 0, byModel: [] }} />
    </Suspense>
  );
}
