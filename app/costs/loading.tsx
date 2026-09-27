import { Page, PageHeader } from '../components/ui';
import { COSTS_DESCRIPTION, CostsBodySkeleton, CostsCardsSkeleton, CostsRangeSkeleton } from './CostsSkeleton';

export default function CostsLoading() {
  return (
    <Page>
      <PageHeader eyebrow="Spend" title="Costs" description={COSTS_DESCRIPTION} />
      <CostsRangeSkeleton />
      <CostsCardsSkeleton />
      <CostsBodySkeleton />
    </Page>
  );
}
