import { requireAuth } from '@/lib/requireAuth';
import AgentsPageClient from './PageClient';

export default async function AgentsPage() {
  await requireAuth();
  const hasDomain = !!(process.env.OLYMPUS_DOMAIN || '').trim();
  return <AgentsPageClient hasDomain={hasDomain} />;
}
