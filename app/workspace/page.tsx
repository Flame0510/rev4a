import type { Metadata } from 'next';
import WorkspaceClient from './WorkspaceClient';

export const metadata: Metadata = { title: 'Workspace — Rev4a' };

export default function WorkspacePage() {
  return <WorkspaceClient />;
}
