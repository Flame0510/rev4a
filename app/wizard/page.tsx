import WizardPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Wizard' };

export const dynamic = 'force-dynamic';

export default function WizardPage() {
  return <WizardPageClient />;
}
