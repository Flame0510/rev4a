import { Skeleton } from '../components/Skeleton';

export const SUBSCRIPTIONS_DESCRIPTION = 'Connect a ChatGPT subscription to your agents. You choose the model in the agent panel.';

/**
 * The accordion header of the real page: caret, the provider name, the "N of M agents
 * connected" area on the right and the muted account line under it. Same classes as the
 * shared Accordion, so the border, the padding and the grid are the real ones.
 */
export function SubscriptionsHeaderSkeleton() {
  return (
    <div className="ui-accordion__header" style={{ cursor: 'default' }} aria-hidden="true">
      <span className="ui-accordion__caret">▶</span>
      <span className="ui-accordion__title"><Skeleton width={132} height={14} /></span>
      <span className="ui-accordion__summary"><Skeleton width={150} height={12} /></span>
      <span className="ui-accordion__detail"><Skeleton width={180} height={10} /></span>
    </div>
  );
}

/** One agent row: a name line, the status pill and the model line under it, and the button. */
export function SubscriptionsRowSkeleton({ nameWidth = 110 }: { nameWidth?: number }) {
  return (
    <div style={{ border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Skeleton width={nameWidth} height={14} />
        <Skeleton width={150} height={20} />
        <Skeleton width={220} height={11} />
      </div>
      <Skeleton width={84} height={28} />
    </div>
  );
}

const NAME_WIDTHS = [96, 128, 84, 112];

/** The Models block: its label and a few model chips. */
export function SubscriptionsModelsSkeleton() {
  return (
    <div aria-hidden="true">
      <div style={{ fontSize: 10, color: 'var(--text-dim, #888)', letterSpacing: '0.06em', marginBottom: 6 }}>MODELS</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Skeleton width={150} height={26} />
        <Skeleton width={170} height={26} />
        <Skeleton width={140} height={26} />
      </div>
    </div>
  );
}

/** The whole accordion, open: header, Models block, `rows` agent rows, the footnote line. */
export function SubscriptionsBodySkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <section className="ui-accordion ui-accordion--open" aria-busy="true">
      <SubscriptionsHeaderSkeleton />
      <div className="ui-accordion__body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' }}>
          <SubscriptionsModelsSkeleton />
          <div style={{ display: 'grid', gap: 8 }}>
            {Array.from({ length: rows }).map((_, i) => (
              <SubscriptionsRowSkeleton key={i} nameWidth={NAME_WIDTHS[i % NAME_WIDTHS.length]} />
            ))}
          </div>
          <Skeleton width="70%" height={11} />
        </div>
      </div>
    </section>
  );
}
