'use client';
// Replaces AgentDrawer.jsx — uses Rev4aApiClient (Facade) instead of raw fetch

import { useEffect, useMemo, useRef, useState } from 'react';
import { useResponsive } from '../design-system';
import type { Session, SessionDetail } from '@/lib/types';
import { Rev4aApiClient } from '@/lib/patterns/ApiClient';
import { deriveSessionDisplayLabel, sessionState } from '@/lib/patterns/sessionPresentation';
import {
  formatUsd,
  formatTokens,
  formatTimeFromUnixSeconds,
  getTimeZone,
  formatDuration,
  truncate,
  statusColor,
  parseEventData,
} from '@/lib/utils/format';
import { useRev4aTimezone } from '@/lib/hooks/useRev4aTimezone';
import Rev4aLoader from './Rev4aLoader';

/** Date and time in the dashboard time zone (the shared formatter shows the time only). Milliseconds in. */
function formatStamp(ms: number | null | undefined): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleString(undefined, {
    timeZone: getTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

/** A subscription session shows the word, never the list price OpenClaw recorded; a paid one keeps $… / not priced. */
function costLabel(session: Pick<Session, 'uses_subscription' | 'cost_usd'>): string {
  if (session.uses_subscription) return 'subscription';
  return session.cost_usd === null ? 'not priced' : formatUsd(session.cost_usd);
}

interface SessionDrawerProps {
  /** The session's uid: `<container>|<session_key>`. */
  sessionId: string | null;
  onClose: () => void;
}

export default function SessionDrawer({ sessionId, onClose }: SessionDrawerProps) {
  useRev4aTimezone(); // re-render when the time zone loads or changes (formatTimeFromUnixSeconds reads it)
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const isMobile = useResponsive('md');

  // ── Drag-to-close per bottom sheet mobile ─────────────────────────────
  const dragStartY = useRef<number | null>(null);
  const sheetRef = useRef<HTMLElement>(null);

  const onDragStart = (e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
    if (sheetRef.current) sheetRef.current.style.transition = 'none';
  };

  const onDragMove = (e: React.TouchEvent) => {
    if (dragStartY.current === null || !sheetRef.current) return;
    const dy = e.touches[0].clientY - dragStartY.current;
    if (dy > 0) sheetRef.current.style.transform = `translateY(${dy}px)`;
  };

  const onDragEnd = (e: React.TouchEvent) => {
    if (dragStartY.current === null || !sheetRef.current) return;
    const dy = e.changedTouches[0].clientY - dragStartY.current;
    sheetRef.current.style.transition = 'transform 0.25s ease';
    if (dy > 80) {
      sheetRef.current.style.transform = 'translateY(100%)';
      setTimeout(onClose, 250);
    } else {
      sheetRef.current.style.transform = 'translateY(0)';
    }
    dragStartY.current = null;
  };

  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      setError('');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    (async () => {
      setLoading(true);
      setError('');
      try {
        const data = await Rev4aApiClient.fetchSessionDetail(sessionId, controller.signal);
        if (!controller.signal.aborted) setDetail(data);
      } catch (e: unknown) {
        if (!controller.signal.aborted) {
          setDetail(null);
          setError(e instanceof Error ? e.message : 'Unexpected error');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [sessionId]);

  if (!sessionId) return null;

  const { session, events, children } = detail ?? { session: null, events: [], children: [] };
  const endedOrUpdated = session?.ended_at ?? session?.updated_at ?? null;
  const state = session ? sessionState(session) : 'idle';

  return (
    <>
      {isMobile && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 299,
            background: 'rgba(0,0,0,0.5)',
          }}
        />
      )}
      <aside
      ref={sheetRef}
      style={isMobile ? {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 300,
        width: '100%',
        maxHeight: '75vh',
        overflowY: 'auto',
        background: 'var(--bg)',
        borderTop: '1px solid var(--border)',
        borderRadius: 0,
        color: 'var(--text)',
        padding: '20px 14px 28px',
        transition: 'transform 0.25s ease',
        touchAction: 'none',
      } : {
        position: 'fixed',
        right: 0,
        top: 0,
        zIndex: 200,
        width: 320,
        maxWidth: '92vw',
        height: '100vh',
        overflowY: 'auto',
        background: 'var(--bg)',
        borderLeft: '1px solid var(--border)',
        color: 'var(--text)',
        padding: '20px 14px 14px',
      }}
    >
      {isMobile && (
        <div
          onTouchStart={onDragStart}
          onTouchMove={onDragMove}
          onTouchEnd={onDragEnd}
          style={{ display: 'flex', justifyContent: 'center', marginBottom: 12, marginTop: -8, padding: '8px 0', cursor: 'grab' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
        </div>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{
          position: 'absolute',
          top: isMobile ? 16 : 14,
          right: 14,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-dim)',
          fontSize: 18,
          lineHeight: 1,
          cursor: 'pointer',
          padding: 4,
          borderRadius: 0,
          transition: 'color 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
      >
        ✕
      </button>

      {loading && <Rev4aLoader label="LOADING SESSION" compact />}
      {error && <div style={{ color: '#f07070' }}>{error}</div>}

      {!loading && !error && session && (
        <>
          <Section>
            <div style={{ color: 'var(--violet)', fontSize: 12, marginBottom: 8 }}>
              {truncate(deriveSessionDisplayLabel(session), 40)}
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 10, overflowWrap: 'anywhere' }}>
              {truncate(session.session_key, 80)}
            </div>
            <Grid>
              <Row label="AGENT">{session.agent_name ?? session.container}</Row>
              <Row label="CONTAINER">{session.container}</Row>
              <Row label="KIND">{session.kind || '-'}</Row>
              <Row label="STATUS">
                <span style={{ color: statusColor(state) }}>●</span>{' '}
                {session.status || 'idle'}
                {session.gone_at ? ' (container gone)' : ''}
              </Row>
              {session.last_error && <Row label="ERROR">{truncate(session.last_error, 200)}</Row>}
              <Row label="MODEL">{[session.provider, session.model].filter(Boolean).join(' / ') || '-'}</Row>
              <Row label="COST">{costLabel(session)}</Row>
              <Row label="TOKENS">
                in: {formatTokens(session.input_tokens)} out: {formatTokens(session.output_tokens)} total: {formatTokens(session.total_tokens)}
              </Row>
              <Row label="STARTED">{formatStamp(session.started_at)}</Row>
              <Row label="UPDATED">{formatStamp(session.updated_at)}</Row>
              <Row label="ENDED">{formatStamp(session.ended_at)}</Row>
              <Row label="DURATION">{formatDuration(session.started_at, endedOrUpdated)}</Row>
              {session.cron_job_id && <Row label="CRON JOB">{truncate(session.cron_job_id, 40)}</Row>}
            </Grid>
          </Section>

          <Section title="RECENT ACTIONS">
            {events.length === 0 && <Muted>No events</Muted>}
            {events.map((evt) => (
              <div key={evt.id ?? `${evt.ts ?? 0}-${evt.type ?? 'event'}`} style={{ fontSize: 12 }}>
                <span style={{ color: 'var(--text-dim)', marginRight: 6 }}>
                  {formatTimeFromUnixSeconds(evt.ts)}
                </span>
                <span style={{ marginRight: 6 }}>{evt.type ?? 'event'}</span>
                <span style={{ color: 'var(--text-dim)' }}>
                  {truncate(parseEventData(evt.data), 80)}
                </span>
              </div>
            ))}
          </Section>

          <Section title="CHILD SESSIONS">
            {children.length === 0 && <Muted>No child sessions</Muted>}
            {children.map((child) => (
              <div key={child.uid} style={{ fontSize: 12 }}>
                <div>{truncate(deriveSessionDisplayLabel(child), 44)}</div>
                <Muted>
                  {child.status || 'idle'} {costLabel(child)}
                </Muted>
              </div>
            ))}
          </Section>
        </>
      )}
    </aside>
    </>
  );
}

// ── Small layout helpers ───────────────────────────────────────────────────

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div style={{ borderTop: title ? '1px solid var(--border)' : 'none', marginTop: title ? 14 : 0, paddingTop: title ? 10 : 0 }}>
      {title && (
        <div style={{ fontSize: 12, color: 'var(--violet)', marginBottom: 8 }}>{title}</div>
      )}
      <div style={{ display: 'grid', gap: 7 }}>{children}</div>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gap: 7, fontSize: 12 }}>{children}</div>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {label} {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{children}</div>;
}
