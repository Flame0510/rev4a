import { Skeleton, CardRowSkeleton } from '../components/Skeleton';

const PageSkeleton = () => (
  <div style={{ padding: '24px 20px', maxWidth: 1080, margin: '0 auto' }}>
    <Skeleton width={120} height={20} accent style={{ marginBottom: 20 }} />
    <CardRowSkeleton count={5} height={48} />
  </div>
);

export default PageSkeleton;
