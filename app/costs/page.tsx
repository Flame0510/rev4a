import CostsPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Costs' };

export default function CostsPage() {
  return <CostsPageClient />;
}
