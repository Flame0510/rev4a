import SkillsPageClient from './PageClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Skills' };

export default function SkillsPage() {
  return <SkillsPageClient />;
}
