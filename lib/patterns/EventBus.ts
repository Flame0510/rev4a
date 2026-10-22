'use client';
// Observer + Singleton: manages one shared SSE connection; components subscribe as observers

import type { StreamMessage, Session, SessionEvent } from '../types';
import { SessionFactory, EventFactory } from './SessionFactory';

// ── Observer interface ─────────────────────────────────────────────────────

export interface IDashboardObserver {
  onSessions?(sessions: Session[], total?: number | null): void;
  onEvents?(events: SessionEvent[]): void;
  onCostUpdate?(today: number): void;
}

// ── Singleton EventBus ─────────────────────────────────────────────────────

function sessionsFingerprint(list: unknown[]): string {
  return (list as Partial<Record<string, unknown>>[])
    .map((s) => [s.uid ?? s.id, s.parent_uid ?? s.parent_id, s.status, s.cost_usd, s.label, s.updated_at, s.ended_at, s.gone_at, s.total_tokens, s.agent_name].join('|'))
    .join('\n');
}

/** The sessions frame carries the Session list, bare or wrapped in { sessions }. */
function framedSessions(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const inner = (data as { sessions?: unknown } | null)?.sessions;
  return Array.isArray(inner) ? inner : [];
}

class Rev4aEventBusClass {
  private static _instance: Rev4aEventBusClass | null = null;
  private observers = new Set<IDashboardObserver>();
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSessionsHash = '';
  private latestSessions: Session[] | null = null;
  private latestTotal: number | null = null;
  private latestEvents: SessionEvent[] | null = null;
  private latestCostToday: number | null = null;

  private constructor() {}

  static get instance(): Rev4aEventBusClass {
    Rev4aEventBusClass._instance ??= new Rev4aEventBusClass();
    return Rev4aEventBusClass._instance;
  }

  subscribe(observer: IDashboardObserver): () => void {
    this.observers.add(observer);
    this.replayTo(observer);
    if (this.observers.size === 1) this.connect();
    return () => this.unsubscribe(observer);
  }

  unsubscribe(observer: IDashboardObserver): void {
    this.observers.delete(observer);
    if (this.observers.size === 0) this.disconnect();
  }

  private connect(): void {
    this.disconnect();
    this.source = new EventSource('/api/stream');

    this.source.onmessage = (e: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(e.data) as StreamMessage;
        this.dispatch(msg);
      } catch {
        // Ignore malformed chunks.
      }
    };

    this.source.onerror = () => {
      this.source?.close();
      this.source = null;
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    };
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.source?.close();
    this.source = null;
  }

  private replayTo(observer: IDashboardObserver): void {
    if (this.latestSessions && observer.onSessions) observer.onSessions(this.latestSessions, this.latestTotal);
    if (this.latestEvents && observer.onEvents) observer.onEvents(this.latestEvents);
    if (this.latestCostToday !== null && observer.onCostUpdate) observer.onCostUpdate(this.latestCostToday);
  }

  private dispatch(msg: StreamMessage): void {
    if (msg.type === 'sessions') {
      const list = framedSessions(msg.data);
      const total = typeof msg.total === 'number' && Number.isFinite(msg.total) ? msg.total : null;
      const hash = `${total ?? ''}#${sessionsFingerprint(list)}`;
      if (hash === this.lastSessionsHash) return;
      this.lastSessionsHash = hash;
      this.latestSessions = SessionFactory.createMany(list);
      this.latestTotal = total;
    } else if (msg.type === 'events') {
      this.latestEvents = EventFactory.createMany(msg.data);
    } else if (msg.type === 'costs') {
      this.latestCostToday = Number(msg.data?.today ?? 0);
    }

    for (const obs of this.observers) {
      if (msg.type === 'sessions' && obs.onSessions && this.latestSessions) {
        obs.onSessions(this.latestSessions, this.latestTotal);
      } else if (msg.type === 'events' && obs.onEvents && this.latestEvents) {
        obs.onEvents(this.latestEvents);
      } else if (msg.type === 'costs' && obs.onCostUpdate && this.latestCostToday !== null) {
        obs.onCostUpdate(this.latestCostToday);
      }
    }
  }
}

export const Rev4aEventBus = Rev4aEventBusClass.instance;
