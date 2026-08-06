import { Skeleton } from '../components/Skeleton';

export default function GatewayLoading() {
  return (
    <div style={{
      padding: '24px 20px',
      maxWidth: 1000,
      margin: '0 auto',
    }}>
      <Skeleton width={80} height={18} accent style={{ marginBottom: 8 }} />
      <Skeleton width={200} height={28} style={{ marginBottom: 20 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[1, 2, 3].map(i => (
          <Skeleton key={i} height={72} style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
        ))}
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {[1, 2, 3, 4].map(i => (
          <Skeleton key={i} width={`${100 - i * 10}%`} height={16} />
        ))}
      </div>
    </div>
  );
}
