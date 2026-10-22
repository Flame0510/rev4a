import SubscriptionsPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Subscriptions' };

export const dynamic = 'force-dynamic';

export default function SubscriptionsPage() {
  return <SubscriptionsPageClient />;
}
