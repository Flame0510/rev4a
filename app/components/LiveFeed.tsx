'use client';

import type { SessionEvent } from '@/lib/types';
import { formatTimeFromUnixSeconds } from '@/lib/utils/format';
import { useRev4aTimezone } from '@/lib/hooks/useRev4aTimezone';
import { SkeletonLines } from './Skeleton';

interface LiveFeedProps {
  events: SessionEvent[];
  loading?: boolean;
}

export default function LiveFeed({ events, loading = false }: LiveFeedProps) {
  useRev4aTimezone(); // re-render when the time zone loads or changes (formatTimeFromUnixSeconds reads it)
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
              key={`${item.id ?? item.ts ?? 0}-${item.event ?? 'evt'}-${index}`}
              className="feed-item"
            >
              <span className="feed-time">{formatTimeFromUnixSeconds(item.ts)}</span>
              &nbsp;<span className="feed-type">{(item.type ?? item.event ?? 'event').replace(/_/g, ' ')}</span>
              {item.agent_name && <span className="feed-agent">{item.agent_name}</span>}
              <span className="feed-label">{item.session_label ?? item.session_id ?? ''}</span>
            </div>
          ))
        )}
      </div>
    </article>
  );
}
