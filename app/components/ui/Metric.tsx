import type { ReactNode } from 'react';
import { SkeletonLines, SkeletonMetric } from '../Skeleton';
import type { Tone } from './tokens';
import { Surface } from './Surface';

interface MetricProps {
  title: string;
  value: ReactNode;
  subtitle?: ReactNode;
  tone?: Tone;
  loading?: boolean;
  /**
   * `sm` is the compact form for grids inside a dialog or a dense panel: same anatomy,
   * smaller value and tighter spacing, so four of them fit on one line.
   */
  size?: 'md' | 'sm';
}

export function Metric({ title, value, subtitle, tone = 'neutral', loading = false, size = 'md' }: MetricProps) {
  return (
    <Surface as="article" tone={tone} className={size === 'sm' ? 'ui-metric--sm' : undefined}>
      <div className="ui-kicker">{title}</div>
      <div className="ui-metric-value">{loading ? <SkeletonMetric /> : value}</div>
      {subtitle !== undefined && <div className="ui-muted ui-metric-subtitle">{loading ? <SkeletonLines count={1} /> : subtitle}</div>}
    </Surface>
  );
}
