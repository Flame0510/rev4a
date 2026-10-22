import SystemPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'System' };

export default function SystemPage() {
  return <SystemPageClient />;
}
