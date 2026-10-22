import CredentialsPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Credentials' };

export const dynamic = 'force-dynamic';

export default function CredentialsPage() {
  return <CredentialsPageClient />;
}
