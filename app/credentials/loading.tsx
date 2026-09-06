import { Page, PageHeader } from '../components/ui';
import { CredentialCardsSkeleton } from '../components/Skeleton';

/**
 * Route-level loading UI, shown while the page chunk streams in.
 *
 * It renders the same chrome and the same skeleton as PageClient's own loading
 * state, so the two hand over without a visible change. The previous version
 * used a generic five-row card list at maxWidth 1080, while the real page is a
 * card grid inside the default 1280 — the skeleton and the page it stood for
 * did not line up.
 */
const PageSkeleton = () => (
  <Page>
    <PageHeader
      eyebrow=""
      title="Credentials"
      description="Store third-party credentials once, sync to all agent containers."
    />
    <CredentialCardsSkeleton />
  </Page>
);

export default PageSkeleton;
