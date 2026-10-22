import ContainersClient from './ContainersClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Containers' };

export default function ContainersPage() {
  return <ContainersClient />;
}
