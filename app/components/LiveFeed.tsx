'use client';

import type { SessionEvent } from '@/lib/types';
import { deriveSessionDisplayLabel } from '@/lib/patterns/sessionPresentation';
import { formatTimeFromUnixSeconds } from '@/lib/utils/format';
import { SkeletonLines } from './Skeleton';

interface LiveFeedProps {
  events: SessionEvent[];
  loading?: boolean;
}

export default function LiveFeed({ events, loading = false }: LiveFeedProps) {
  return (
    <article className="panel feed-panel">
      <h2>Live Events</h2>
      <div>
        {loading ? (
          <div style={{ padding: 12 }}>
            <SkeletonLines count={5} />
          </div>
        ) : events.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-msg">Waiting for activity…</div>
          </div>
        ) : (
          events.map((item, index) => (
            <div
              key={`${item.ts ?? 0}-${item.event ?? 'evt'}-${index}`}
              className="feed-item"
            >
              <span className="feed-time">{formatTimeFromUnixSeconds(item.ts)}</span>
              &nbsp;<span className="feed-type">{item.type ?? item.event ?? 'event'}</span>
              <span className="feed-label">
                {deriveSessionDisplayLabel({
                  session_id: item.session_id ?? '',
                  label: item.session_label ?? item.label ?? null,
                  lineage_label: null,
                  task_preview: null,
                })}
              </span>
            </div>
          ))
        )}
      </div>
    </article>
  );
}
