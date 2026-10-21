// Facade + Singleton: wraps all Rev4a API calls behind a clean interface
import type { Session, SessionDetail, Costs, SessionEvent } from '../types';
import { SessionFactory, EventFactory } from './SessionFactory';
import { adaptCosts, adaptSession } from './ApiAdapter';
import { parseUid } from './sessionPresentation';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...init?.headers },
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** GET /api/sessions answers { sessions, total, version }; a bare array is still accepted. */
export function sessionsFromResponse(raw: unknown): Session[] {
  const list = Array.isArray(raw) ? raw : (raw as { sessions?: unknown } | null)?.sessions;
  return Array.isArray(list) ? SessionFactory.createMany(list) : [];
}

class Rev4aApiClientClass {
  private static _instance: Rev4aApiClientClass | null = null;

  private constructor() {}

  static get instance(): Rev4aApiClientClass {
    Rev4aApiClientClass._instance ??= new Rev4aApiClientClass();
    return Rev4aApiClientClass._instance;
  }

  /** `since` in ms; 0 asks for every session. Without it the server sends active ones plus the last 7 days. */
  async fetchSessions(opts: { since?: number; signal?: AbortSignal } = {}): Promise<Session[]> {
    const qs = opts.since === undefined ? '' : `?since=${Math.max(0, Math.floor(opts.since))}`;
    const raw = await apiFetch<unknown>(`/api/sessions${qs}`, { signal: opts.signal });
    return sessionsFromResponse(raw);
  }

  async fetchCosts(): Promise<Costs> {
    const raw = await apiFetch<Record<string, unknown>>('/api/costs');
    return adaptCosts(raw);
  }

  /** `uid` is `<container>|<session_key>`. */
  async fetchSessionDetail(uid: string, signal?: AbortSignal): Promise<SessionDetail> {
    const parsed = parseUid(uid);
    if (!parsed) throw new Error('Unknown session');
    const raw = await apiFetch<Record<string, unknown>>(
      `/api/session?container=${encodeURIComponent(parsed.container)}&key=${encodeURIComponent(parsed.key)}`,
      { signal },
    );
    return {
      session: adaptSession((raw.session ?? raw) as Record<string, unknown>),
      events: Array.isArray(raw.events)
        ? EventFactory.createMany(raw.events as unknown[])
        : [],
      children: Array.isArray(raw.children)
        ? SessionFactory.createMany(raw.children as unknown[])
        : [],
    };
  }

  async fetchEvents(limit = 50): Promise<SessionEvent[]> {
    const raw = await apiFetch<unknown[]>(`/api/events?limit=${limit}`);
    return Array.isArray(raw) ? EventFactory.createMany(raw) : [];
  }
}

export const Rev4aApiClient = Rev4aApiClientClass.instance;
