import CronsPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Crons' };

export default function CronsPage() {
  return <CronsPageClient />;
}
