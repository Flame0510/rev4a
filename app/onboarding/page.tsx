import { requireAuth } from '@/lib/requireAuth';
import OnboardingPageClient from './PageClient';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  await requireAuth();
  return <OnboardingPageClient />;
}
