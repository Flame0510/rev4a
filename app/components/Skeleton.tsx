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
