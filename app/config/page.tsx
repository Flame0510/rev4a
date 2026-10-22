import ConfigPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Config' };

export const dynamic = 'force-dynamic';

export default function ConfigPage() {
  return <ConfigPageClient />;
}
