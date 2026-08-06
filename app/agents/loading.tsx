import { Skeleton, CardRowSkeleton } from '../components/Skeleton';

export default function AgentsLoading() {
  return (
    <div style={{
      padding: '24px 20px',
      maxWidth: 1080,
      margin: '0 auto',
    }}>
      <Skeleton width={120} height={24} accent style={{ marginBottom: 20 }} />
      <CardRowSkeleton count={5} height={56} />
    </div>
  );
}
