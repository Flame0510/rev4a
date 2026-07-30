'use client';

import type { ModelCost } from '@/lib/types';
import { formatUsd } from '@/lib/utils/format';
import { SkeletonLines } from './Skeleton';

interface CostBreakdownProps {
  byModel: ModelCost[];
  loading?: boolean;
}

export default function CostBreakdown({ byModel, loading = false }: CostBreakdownProps) {
  return (
    <article className="panel cost-panel">
      <h2>Costs by Model (Today)</h2>
      <div>
        {loading ? (
          <div style={{ padding: 12 }}>
            <SkeletonLines count={4} />
          </div>
        ) : byModel.length === 0 ? (
          <div className="cost-row">
            <span className="k">no data</span>
            <span className="v">$0.00</span>
          </div>
        ) : (
          byModel.map((row, index) => (
            <div key={`${row.model ?? 'unknown'}-${index}`} className="cost-row">
              <span className="k">{row.model ?? 'unknown'}</span>
              <span className="v">{formatUsd(row.cost_usd)}</span>
            </div>
          ))
        )}
      </div>
    </article>
  );
}
