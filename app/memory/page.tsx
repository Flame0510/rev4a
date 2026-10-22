import MemoryContextPageClient from './MemoryContextPageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Context' };

export const dynamic = 'force-dynamic';

export default function MemoryPage() {

  return <MemoryContextPageClient />;
}
