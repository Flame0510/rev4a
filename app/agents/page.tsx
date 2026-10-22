import AgentsPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Agents' };

export default function AgentsPage() {
  return <AgentsPageClient />;
}
