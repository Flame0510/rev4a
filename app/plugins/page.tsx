import PluginsPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Plugins' };

export default function PluginsPage() {
  return <PluginsPageClient />;
}
