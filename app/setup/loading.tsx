import { Skeleton } from '../components/Skeleton';

export default function SetupLoading() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'var(--bg)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, maxWidth: 340, width: '100%' }}>
        <Skeleton width={80} height={80} accent variant="circle" />
        <Skeleton width={200} height={28} accent />
        <Skeleton width={300} height={16} />
        <Skeleton width="100%" height={48} style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
        <Skeleton width="100%" height={48} style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
      </div>
    </div>
  );
}
