import GatewayPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Gateway' };

export default function GatewayPage() {
  return <GatewayPageClient />;
}
