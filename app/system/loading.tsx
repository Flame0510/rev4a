import { Page, PageHeader } from '../components/ui';
import { SystemAgentsHeading, SystemAgentsSkeleton, SystemCardsSkeleton, SystemChartsSkeleton, SystemDescription, SystemRangeSkeleton } from './SystemSkeleton';

export default function SystemLoading() {
  return (
    <Page>
      <PageHeader eyebrow="Host" title="System" description={<SystemDescription host={null} />} />
      <SystemCardsSkeleton />
      <SystemRangeSkeleton />
      <SystemChartsSkeleton />
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SystemAgentsHeading />
        <SystemAgentsSkeleton />
      </section>
    </Page>
  );
}
