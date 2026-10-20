import { Suspense } from 'react';
import type { Metadata } from 'next';
import WorkspaceClient from './WorkspaceClient';
import WorkspaceLoading from './loading';

export const metadata: Metadata = { title: 'Workspace — Rev4a' };

export default function WorkspacePage() {
  // The client reads ?agent=&file=&hidden= (useSearchParams), which needs a Suspense boundary.
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <WorkspaceClient />
    </Suspense>
  );
}
