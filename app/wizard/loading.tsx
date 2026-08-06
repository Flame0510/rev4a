import { Skeleton } from '../components/Skeleton';

export default function WizardLoading() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'var(--bg)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, maxWidth: 560, width: '100%', padding: 20 }}>
        <Skeleton width={80} height={80} accent variant="circle" />
        <Skeleton width={240} height={32} accent />
        <Skeleton width={480} height={16} />
        <div style={{ display: 'grid', gap: 10, width: '100%', marginTop: 12 }}>
          {[1, 2, 3].map(i => (
            <Skeleton key={i} width="100%" height={60} style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
          ))}
        </div>
      </div>
    </div>
  );
}
