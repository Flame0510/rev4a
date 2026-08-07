import { Skeleton, CardRowSkeleton } from '../components/Skeleton';

export default function ContainersLoading() {
  return (
    <div style={{
      padding: '16px 20px',
      maxWidth: 1080,
      margin: '0 auto',
      height: '100%',
      boxSizing: 'border-box',
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
      paddingBottom: 72,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Skeleton width={140} height={20} accent />
      </div>
      <CardRowSkeleton count={4} height={56} />
    </div>
  );
}
