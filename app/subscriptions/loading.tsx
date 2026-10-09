import { Page, PageHeader } from '../components/ui';
import { SUBSCRIPTIONS_DESCRIPTION, SubscriptionsBodySkeleton } from './SubscriptionsSkeleton';

/** Route-level loading UI: the same header and the same open accordion as the page. */
const PageSkeleton = () => (
  <Page maxWidth={1080}>
    <PageHeader eyebrow="" title="Subscriptions" description={SUBSCRIPTIONS_DESCRIPTION} />
    <SubscriptionsBodySkeleton />
  </Page>
);

export default PageSkeleton;
