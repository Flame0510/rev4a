import { requireAuth } from '@/lib/requireAuth';
import WizardPageClient from './PageClient';

export const dynamic = 'force-dynamic';

export default async function WizardPage() {
  await requireAuth();
  return <WizardPageClient />;
}
