import type { Metadata } from 'next';
import { requireAuth } from '@/lib/requireAuth';
import WorkspaceClient from './WorkspaceClient';

export const metadata: Metadata = { title: 'Workspace — Rev4a' };

export default async function WorkspacePage() {
  await requireAuth();
  return <WorkspaceClient />;
}
