import { Skeleton } from '../components/Skeleton';
import { Surface } from '../components/ui';

/**
 * Placeholders for the System page, used by `loading.tsx` while the route loads and by the
 * page before its first answer. Each shimmer sits inside the same class as the text it
 * stands in for (`ui-kicker`, `ui-metric-value`, `ui-key-value`, `ui-meter`), so the line
 * boxes — and the card, grid and page heights — are the real ones and nothing jumps when
 * the data lands. Measured against the loaded page, desktop and mobile.
 */

/**
 * The header description: a fixed sentence, then the host facts on one line of their own —
 * cut with an ellipsis rather than wrapped, so a long hostname cannot change the height.
 */
export function SystemDescription({ host }: { host: string | null }) {
  return (
    <>
      CPU, memory and storage of the machine Rev4a runs on.
      {/* width 0 + min-width 100%: the line takes the header's width without adding its own
          (unwrapped) width to the header's minimum — else a long hostname widens the page. */}
      <span style={{ display: 'block', width: 0, minWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {host ?? <Skeleton as="span" inline width={260} height={12} />}
      </span>
    </>
  );
}

function KeyValueRow({ label, value }: { label: number; value: number }) {
  return (
    <div className="ui-key-value">
      <span><Skeleton as="span" inline width={label} height={11} /></span>
      <span><Skeleton as="span" inline width={value} height={11} /></span>
    </div>
  );
}

function MeterRow() {
  return (
    <div className="ui-meter">
      <Skeleton height={6} style={{ flex: 1 }} />
    </div>
  );
}

function FigureCard({ title, rows }: { title: number; rows: [number, number][] }) {
  return (
    <Surface as="article">
      <div className="ui-kicker"><Skeleton as="span" inline width={title} height={10} /></div>
      <div className="ui-metric-value"><Skeleton as="span" inline width={72} height={26} accent /></div>
      <MeterRow />
      <div className="ui-key-values" style={{ marginTop: 12 }}>
        {rows.map(([l, v], i) => <KeyValueRow key={i} label={l} value={v} />)}
      </div>
    </Surface>
  );
}

export function SystemCardsSkeleton() {
  return (
    <div className="system-cards" aria-busy="true" aria-label="Loading machine metrics">
      <FigureCard title={28} rows={[[40, 20], [120, 110]]} />
      <FigureCard title={52} rows={[[80, 110], [64, 48], [110, 90]]} />
      <Surface as="article">
        <div className="ui-kicker"><Skeleton as="span" inline width={56} height={10} /></div>
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13 }}><Skeleton as="span" inline width={24} height={12} /></span>
            <span style={{ display: 'flex', gap: 4 }}>
              <span className="ui-pill"><Skeleton as="span" inline width={40} height={9} /></span>
              <span className="ui-pill"><Skeleton as="span" inline width={56} height={9} /></span>
            </span>
          </div>
          <MeterRow />
          <div style={{ marginTop: 6 }}>
            <KeyValueRow label={150} value={80} />
          </div>
        </div>
      </Surface>
    </div>
  );
}

/** The chart grid: CPU, memory and one disk, each at the real plot height (160 px). */
export function SystemChartsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="system-charts" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <Surface as="section" key={i}>
          <div className="ui-kicker"><Skeleton as="span" inline width={150} height={10} /></div>
          <Skeleton height={160} />
          <div className="ui-chart__table">
            <div style={{ fontSize: 10 }}><Skeleton as="span" inline width={48} height={9} /></div>
          </div>
        </Surface>
      ))}
    </div>
  );
}

/** The range switch (1h · 24h · 7d · 30d) for the route's loading state, where the real tabs cannot render. */
export function SystemRangeSkeleton() {
  return (
    <div
      aria-hidden="true"
      style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 20, height: 44, alignItems: 'center' }}
    >
      {[18, 24, 18, 24].map((w, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <Skeleton width={w} height={11} />
        </div>
      ))}
    </div>
  );
}
