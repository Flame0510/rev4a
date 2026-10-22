import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Setup' };
export const dynamic = 'force-dynamic';

import SetupPageClient from './PageClient';

export default function SetupPage() {
  return <SetupPageClient />;
}
