import { requireAuth } from '@/lib/requireAuth';
import ContainersClient from './ContainersClient';

export default async function ContainersPage() {
  await requireAuth();
  return <ContainersClient />;
}
