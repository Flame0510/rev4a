import { Skeleton } from '../components/Skeleton';
import { Surface } from '../components/ui';

/**
 * Placeholders for the Costs page, used by `loading.tsx` while the route loads and by the
 * page before its first answer. Each shimmer sits in the class of the text it stands in
 * for (`ui-kicker`, `ui-metric-value`, `ui-key-value`, `ui-meter`), so the boxes have the
 * real heights and nothing jumps when the data lands.
 */

function KeyValueRow({ label, value }: { label: number; value: number }) {
  return (
    <div className="ui-key-value">
      <span><Skeleton as="span" inline width={label} height={11} /></span>
      <span><Skeleton as="span" inline width={value} height={11} /></span>
    </div>
  );
}

function FigureCard({ title, rows }: { title: number; rows: number }) {
  return (
    <Surface as="article">
      <div className="ui-kicker"><Skeleton as="span" inline width={title} height={10} /></div>
      <div className="ui-metric-value"><Skeleton as="span" inline width={88} height={26} accent /></div>
      <div className="ui-key-values" style={{ marginTop: 12 }}>
        {Array.from({ length: rows }).map((_, i) => <KeyValueRow key={i} label={70 + (i % 2) * 30} value={48} />)}
      </div>
    </Surface>
  );
}

export function CostsCardsSkeleton() {
  return (
    <div className="costs-cards" aria-busy="true" aria-label="Loading costs">
      <FigureCard title={40} rows={2} />
      <FigureCard title={64} rows={4} />
      <FigureCard title={48} rows={4} />
    </div>
  );
}

/** One breakdown list: a title, then rows of name and figure over a share meter. */
function ListSkeleton({ rows }: { rows: number }) {
  return (
    <Surface as="section">
      <div className="ui-kicker"><Skeleton as="span" inline width={90} height={10} /></div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ marginTop: 14 }}>
          <KeyValueRow label={140 - (i % 3) * 20} value={56} />
          <div className="ui-meter"><Skeleton height={6} style={{ flex: 1 }} /></div>
        </div>
      ))}
    </Surface>
  );
}

export function CostsBodySkeleton() {
  return (
    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Surface as="section">
        <div className="ui-kicker"><Skeleton as="span" inline width={120} height={10} /></div>
        <Skeleton height={160} />
      </Surface>
      <div className="costs-lists">
        <ListSkeleton rows={3} />
        <ListSkeleton rows={3} />
      </div>
    </div>
  );
}

/** The range switch (Today · 7 days · 30 days) for the route's loading state. */
export function CostsRangeSkeleton() {
  return (
    <div
      aria-hidden="true"
      style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 20, height: 44, alignItems: 'center' }}
    >
      {[36, 44, 50].map((w, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <Skeleton width={w} height={11} />
        </div>
      ))}
    </div>
  );
}

export const COSTS_DESCRIPTION = 'What each agent spent, as its own OpenClaw priced it with the rates Rev4a syncs. Days are UTC.';
