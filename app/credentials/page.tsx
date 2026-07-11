import { requireAuth } from '@/lib/requireAuth';
import CredentialsPageClient from './PageClient';

export const dynamic = 'force-dynamic';

export default async function CredentialsPage() {
  await requireAuth();
  return <CredentialsPageClient />;
}
