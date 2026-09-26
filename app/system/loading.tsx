import { Page, PageHeader } from '../components/ui';
import { SystemCardsSkeleton, SystemChartsSkeleton, SystemDescription, SystemRangeSkeleton } from './SystemSkeleton';

export default function SystemLoading() {
  return (
    <Page>
      <PageHeader eyebrow="Host" title="System" description={<SystemDescription host={null} />} />
      <SystemCardsSkeleton />
      <SystemRangeSkeleton />
      <SystemChartsSkeleton />
    </Page>
  );
}
