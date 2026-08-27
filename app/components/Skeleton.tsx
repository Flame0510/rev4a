'use client';

type SkeletonProps = {
  width?: string | number;
  height?: string | number;
  /** Extra accent glow — violet tint */
  accent?: boolean;
  /** Shape variant */
  variant?: 'text' | 'block' | 'card' | 'circle';
  /** Inline display */
  inline?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

export function Skeleton({
  width = '100%',
  height,
  accent = false,
  variant = 'block',
  inline = false,
  className,
  style,
}: SkeletonProps) {
  const base: React.CSSProperties = {
    display: inline ? 'inline-block' : 'block',
    width,
    height: height ?? (variant === 'text' ? '1em' : variant === 'block' ? 16 : variant === 'circle' ? 32 : 80),
    background: accent
      ? 'linear-gradient(90deg, rgba(146,91,252,0.06), rgba(146,91,252,0.14), rgba(146,91,252,0.06))'
      : 'linear-gradient(90deg, rgba(255,255,255,0.035), rgba(255,255,255,0.07), rgba(255,255,255,0.035))',
    backgroundSize: '220% 100%',
    animation: 'skeleton-shimmer 1.35s ease-in-out infinite',
    borderRadius: variant === 'circle' ? '50%' : 0,
    verticalAlign: inline ? 'middle' : undefined,
    ...style,
  };
  return <div className={className} style={base} aria-hidden="true" />;
}

/** Tree skeleton — simulates file tree structure like workspace sidebar */
export function TreeSkeleton({ rows = 12, indentLevels = true }: { rows?: number; indentLevels?: boolean }) {
  const baseIndent = 14;
  const depths = indentLevels
    ? [0, 0, 1, 2, 0, 1, 1, 0, 0, 0, 1, 2, 3, 0, 1, 0, 0, 2, 0, 0]
    : Array.from({ length: rows }, () => 0);

  return (
    <div style={{ padding: '6px 0 24px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {depths.slice(0, rows).map((depth, i) => {
        const hasChevron = depth < (depths[i + 1] ?? -1);
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: `3px 8px 3px ${8 + depth * baseIndent}px`,
            }}
          >
            {/* chevron / spacer */}
            {hasChevron ? (
              <Skeleton width={10} height={10} accent />
            ) : (
              <div style={{ width: 10, flexShrink: 0 }} />
            )}
            {/* icon */}
            <Skeleton width={14} height={14} accent />
            {/* name */}
            <Skeleton
              width={`${35 + Math.sin(i * 2.1) * 25 + (i % 3) * 10}%`}
              height={10}
              variant="block"
            />
            {/* size */}
            {i % 3 === 1 && <Skeleton width={32} height={10} style={{ marginLeft: 'auto' }} />}
          </div>
        );
      })}
    </div>
  );
}

/** Code skeleton — simulates code editor lines */
export function CodeSkeleton({ lines = 12 }: { lines?: number }) {
  const lineWidths = [0.82, 0.45, 0.68, 1, 0.55, 0.72, 0.38, 0.91, 0.6, 0.33, 0.77, 0.5, 0.65, 0.88, 0.42, 0.74, 0.57, 0.49];

  return (
    <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
      {lineWidths.slice(0, lines).map((w, i) => (
        <Skeleton key={i} width={`${w * 100}%`} height={11} />
      ))}
    </div>
  );
}

/**
 * Cron job rows — mirrors the real row in the scheduled-jobs column so the
 * layout doesn't jump when the data lands: same 12px/14px padding, same divider,
 * same title/description/badge header, schedule line, and NEXT RUN / LAST RUN
 * grid. Widths vary per row so it reads as a list rather than a stack of bars.
 */
export function CronJobsSkeleton({ rows = 5 }: { rows?: number }) {
  const shapes = [
    { title: '58%', desc: '82%', badge: 54, expr: '34%' },
    { title: '42%', desc: null, badge: 40, expr: '28%' },
    { title: '66%', desc: '71%', badge: 62, expr: '40%' },
    { title: '50%', desc: null, badge: 46, expr: '31%' },
    { title: '61%', desc: '64%', badge: 58, expr: '36%' },
    { title: '45%', desc: null, badge: 50, expr: '26%' },
  ];

  return (
    <div aria-hidden="true">
      {shapes.slice(0, rows).map((s, i) => (
        <div key={i} style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          {/* Header: title + optional description on the left, agent pill right */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Skeleton width={s.title} height={12} accent />
              {s.desc && <Skeleton width={s.desc} height={9} style={{ marginTop: 4 }} />}
            </div>
            <Skeleton width={s.badge} height={13} style={{ flexShrink: 0 }} />
          </div>

          {/* Schedule line: label + cron expression */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <Skeleton width={46} height={9} />
            <Skeleton width={s.expr} height={10} />
          </div>

          {/* NEXT RUN / LAST RUN grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
            {[0, 1].map((c) => (
              <div key={c}>
                <Skeleton width={52} height={8} style={{ marginBottom: 3 }} />
                <Skeleton width="72%" height={10} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Cron run-history entries — one timestamp line plus a status/duration row,
 * matching the entries the runs column renders once a job is selected.
 */
export function CronRunsSkeleton({ rows = 6 }: { rows?: number }) {
  const widths = ['64%', '48%', '71%', '55%', '60%', '44%'];
  return (
    <div aria-hidden="true">
      {widths.slice(0, rows).map((w, i) => (
        <div key={i} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
            <Skeleton width={w} height={10} />
            <Skeleton width={38} height={11} style={{ flexShrink: 0 }} />
          </div>
          <Skeleton width="30%" height={9} />
        </div>
      ))}
    </div>
  );
}

/* ─── Legacy aliases (used by existing components) ────────────────────────── */
/** Stack of horizontal skeleton lines */
export function SkeletonLines({ count = 3, width }: { count?: number; width?: string | number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} width={width ?? `${85 - i * 7}%`} height={12} />
      ))}
    </div>
  );
}

/** Metric skeleton — a label line above a large value bar */
export function SkeletonMetric({ width: w }: { width?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Skeleton width={w ?? 64} height={10} />
      <Skeleton width={w ?? 88} height={24} accent />
    </div>
  );
}

/** Card rows skeleton — simulates a grid/list of cards */
export function CardRowSkeleton({ count = 3, height = 56 }: { count?: number; height?: number }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          height={height}
          style={{ border: '1px solid rgba(255,255,255,0.06)' }}
        />
      ))}
    </div>
  );
}
