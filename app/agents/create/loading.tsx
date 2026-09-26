import { Skeleton } from '../../components/Skeleton';

/**
 * Create Agent while the route loads: the template step's own frame (same wrappers,
 * paddings and font boxes as PageClient.tsx), not the Agents list's rows — so opening it
 * from "+ New" shows its shape at once and nothing moves when it lands.
 */

function Line({ width, size }: { width: number | string; size: number }) {
  return <div style={{ fontSize: size }}><Skeleton as="span" inline width={width} height={Math.round(size * 0.8)} /></div>;
}

/** One card: an avatar, a name line, a description (one or two lines). */
function Card({ square, lines, padding }: { square: boolean; lines: number; padding: string }) {
  return (
    <div style={{ display: 'flex', alignItems: square ? 'flex-start' : 'center', gap: 12, padding, border: '1px solid var(--border)' }}>
      <Skeleton width={square ? 32 : 28} height={square ? 32 : 28} variant={square ? 'block' : 'circle'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Line width={110} size={14} />
        <div style={{ marginTop: 2 }}>
          {Array.from({ length: lines }).map((_, i) => <Line key={i} width={i === lines - 1 ? '45%' : '92%'} size={11} />)}
        </div>
      </div>
    </div>
  );
}

export default function CreateAgentLoading() {
  return (
    <div aria-busy="true" style={{ minHeight: '100dvh', overflowY: 'auto', paddingBottom: 72, boxSizing: 'border-box', width: '100%' }}>
      <div style={{ width: '100%', maxWidth: 760, margin: '0 auto', padding: '24px 16px', boxSizing: 'border-box' }}>
        <div style={{ fontSize: 20, fontWeight: 500, marginBottom: 24 }}>
          <Skeleton as="span" inline width={150} height={20} accent />
        </div>
        <div style={{ fontSize: 12, marginBottom: 16 }}><Skeleton as="span" inline width={230} height={10} /></div>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 10, marginBottom: 8 }}><Skeleton as="span" inline width={130} height={8} /></div>
          <Card square lines={2} padding="16px" />
        </div>
        <div style={{ fontSize: 10, marginBottom: 8 }}><Skeleton as="span" inline width={140} height={8} /></div>
        <div style={{ display: 'grid', gap: 8 }}>
          {[0, 1, 2].map((i) => <Card key={i} square={false} lines={1} padding="14px 16px" />)}
        </div>
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
          <Skeleton width={70} height={28} />
          <Skeleton width={62} height={28} accent />
        </div>
      </div>
    </div>
  );
}
