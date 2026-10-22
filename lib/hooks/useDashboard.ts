'use client';
// Composes EventBus, FilterStrategy, and local state into one dashboard hook

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import type { Session, SessionEvent, Costs, FilterConfig, Period, AgentOption } from '../types';
import { Rev4aEventBus } from '../patterns/EventBus';
import { buildFilterStrategy } from '../patterns/FilterStrategy';
import { sessionsFromResponse, sessionsTotalFromResponse } from '../patterns/ApiClient';
import {
  buildAgentOptions,
  decorateEvents,
  eventMatchesFilter,
  expandWithParents,
  isSessionActive,
  resolveAgentFilter,
  PERIOD_MS,
} from '../patterns/sessionPresentation';
import { PERIODS } from '../types';
import { adaptCosts } from '../patterns/ApiAdapter';
import { apiFetch } from '../apiFetch';

function filterFromParams(params: URLSearchParams): Partial<FilterConfig> {
  const patch: Partial<FilterConfig> = {};
  const agent = params.get('agent');
  if (agent) patch.agent = agent;
  const period = params.get('period');
  if (period && (PERIODS as readonly string[]).includes(period)) patch.period = period as Period;
  const active = params.get('active');
  if (active !== null) patch.showOnlyActive = active === '1';
  const cron = params.get('cron');
  if (cron !== null) patch.showCron = cron !== '0';
  return patch;
}

function filterToParams(filter: FilterConfig): URLSearchParams {
  const p = new URLSearchParams();
  if (filter.agent !== 'all') p.set('agent', filter.agent);
  if (filter.period !== '7d') p.set('period', filter.period);
  if (filter.showOnlyActive) p.set('active', '1');
  if (!filter.showCron) p.set('cron', '0');
  return p;
}

// ── State ──────────────────────────────────────────────────────────────────

interface DashboardState {
  sessions: Session[];
  /** Real number of sessions behind `sessions` (the list is capped); null when unknown. */
  sessionsTotal: number | null;
  /** Sessions older than the stream's window, fetched for a period longer than 7 days. */
  history: Session[];
  events: SessionEvent[];
  costs: Costs;
  filter: FilterConfig;
  selectedSessionId: string | null;
  hasSessionsLoaded: boolean;
  hasCostLoaded: boolean;
}

type Action =
  | { type: 'SET_SESSIONS'; sessions: Session[]; total?: number | null }
  | { type: 'SET_HISTORY'; sessions: Session[] }
  | { type: 'SET_EVENTS'; events: SessionEvent[] }
  | { type: 'PREPEND_EVENTS'; events: SessionEvent[] }
  | { type: 'SET_COSTS'; costs: Partial<Costs> }
  | { type: 'UPDATE_COST_TODAY'; today: number }
  | { type: 'SET_FILTER'; patch: Partial<FilterConfig> }
  | { type: 'SELECT_SESSION'; id: string | null };

function reducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case 'SET_SESSIONS':
      return { ...state, sessions: action.sessions, sessionsTotal: action.total ?? null, hasSessionsLoaded: true };
    case 'SET_HISTORY':
      return { ...state, history: action.sessions };
    case 'SET_EVENTS':
      return {
        ...state,
        events: action.events.slice(0, 50),
      };
    case 'PREPEND_EVENTS':
      return {
        ...state,
        events: [...action.events, ...state.events]
          .filter((event, index, all) => index === all.findIndex((candidate) => candidate.id === event.id && candidate.ts === event.ts && candidate.session_id === event.session_id && candidate.type === event.type))
          .slice(0, 50),
      };
    case 'SET_COSTS':
      return { ...state, costs: { ...state.costs, ...action.costs }, hasCostLoaded: true };
    case 'UPDATE_COST_TODAY':
      return { ...state, costs: { ...state.costs, today: action.today }, hasCostLoaded: true };
    case 'SET_FILTER':
      return { ...state, filter: { ...state.filter, ...action.patch } };
    case 'SELECT_SESSION':
      return { ...state, selectedSessionId: action.id };
    default:
      return state;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────

interface UseDashboardOptions {
  initialCosts?: Partial<Costs>;
}

export function useDashboard({ initialCosts }: UseDashboardOptions = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialFilter: FilterConfig = {
    agent: 'all',
    showOnlyActive: false,
    showCron: true,
    period: '7d',
    ...filterFromParams(searchParams),
  };

  const [state, dispatch] = useReducer(reducer, {
    sessions: [],
    sessionsTotal: null,
    history: [],
    events: [],
    costs: { today: 0, allTime: 0, byModel: [], ...initialCosts },
    filter: initialFilter,
    selectedSessionId: null,
    hasSessionsLoaded: false,
    hasCostLoaded: false,
  });

  const hasSessionsLoadedRef = useRef(false);
  const hasCostLoadedRef = useRef(false);

  useEffect(() => {
    hasSessionsLoadedRef.current = state.hasSessionsLoaded;
  }, [state.hasSessionsLoaded]);

  useEffect(() => {
    hasCostLoadedRef.current = state.hasCostLoaded;
  }, [state.hasCostLoaded]);

  useEffect(() => {
    const controller = new AbortController();

    const unsubscribe = Rev4aEventBus.subscribe({
      onSessions: (sessions, total) => dispatch({ type: 'SET_SESSIONS', sessions, total }),
      onEvents: (events) => dispatch({ type: 'PREPEND_EVENTS', events }),
      onCostUpdate: (today) => dispatch({ type: 'UPDATE_COST_TODAY', today }),
    });

    apiFetch('/api/sessions', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((raw: unknown) => {
        if (!hasSessionsLoadedRef.current) {
          dispatch({ type: 'SET_SESSIONS', sessions: sessionsFromResponse(raw), total: sessionsTotalFromResponse(raw) });
        }
      })
      .catch(() => {});

    apiFetch('/api/events?limit=20', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((events: SessionEvent[]) => {
        if (Array.isArray(events)) dispatch({ type: 'SET_EVENTS', events });
      })
      .catch(() => {});

    apiFetch('/api/costs', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((rawCosts: Partial<Costs>) => {
        const costs = adaptCosts(rawCosts as Record<string, unknown>);
        if (!hasCostLoadedRef.current || costs.allTime || costs.byModel.length) {
          dispatch({ type: 'SET_COSTS', costs });
        }
      })
      .catch(() => {});

    return () => {
      controller.abort();
      unsubscribe();
    };
  }, []);

  // The agents: containers (docker name) with their display name. Filters work on the container.
  const [knownAgents, setKnownAgents] = useState<Array<{ container: string; label: string; running: boolean }>>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      apiFetch('/api/agents', { signal: controller.signal })
        .then((r) => r.json())
        .then((agents: Array<{ agentId: string; displayName?: string; name: string; state?: string }>) => {
          if (Array.isArray(agents)) {
            setKnownAgents(
              agents
                .filter((a) => a.name)
                .map((a) => ({ container: a.name, label: a.displayName || a.name, running: a.state === 'running' })),
            );
            setAgentsLoaded(true);
          }
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      controller.abort();
      clearInterval(t);
    };
  }, []);

  // A period longer than the stream's 7 days is read from the API (and re-read, since the stream does not carry it).
  const { period } = state.filter;
  useEffect(() => {
    if (period === '1d' || period === '3d' || period === '7d') {
      dispatch({ type: 'SET_HISTORY', sessions: [] });
      return;
    }
    let controller = new AbortController();
    const load = () => {
      controller.abort();
      controller = new AbortController();
      const since = period === 'all' ? 0 : Date.now() - PERIOD_MS[period];
      apiFetch(`/api/sessions?since=${since}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((raw: unknown) => dispatch({ type: 'SET_HISTORY', sessions: sessionsFromResponse(raw) }))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      controller.abort();
      clearInterval(t);
    };
  }, [period]);

  // The stream is current; history only adds what the stream does not carry.
  const allSessions = useMemo(() => {
    if (!state.history.length) return state.sessions;
    const live = new Set(state.sessions.map((s) => s.uid));
    return [...state.sessions, ...state.history.filter((s) => !live.has(s.uid))];
  }, [state.sessions, state.history]);

  const availableAgents: AgentOption[] = useMemo(
    () => buildAgentOptions(knownAgents, allSessions),
    [knownAgents, allSessions],
  );

  // `?agent=` may hold an old display name: it is mapped to a container once the agents are known.
  // When /api/agents is down, the session rows (container + agent name) resolve it; an agent that
  // cannot be resolved means 'all', never an empty page.
  const agentsKnown = agentsLoaded || state.hasSessionsLoaded;
  const filter: FilterConfig = useMemo(
    () => ({ ...state.filter, agent: agentsKnown ? resolveAgentFilter(state.filter.agent, availableAgents, allSessions) : state.filter.agent }),
    [state.filter, agentsKnown, availableAgents, allSessions],
  );

  const visibleLeafSessions = useMemo(() => buildFilterStrategy(filter).filter(allSessions), [allSessions, filter]);

  const visibleSessions = useMemo(() => {
    const expanded = expandWithParents(allSessions, visibleLeafSessions, { showCron: filter.showCron });
    return expanded.length ? expanded : visibleLeafSessions;
  }, [allSessions, visibleLeafSessions, filter.showCron]);

  const decoratedEvents = useMemo(() => decorateEvents(state.events, allSessions), [state.events, allSessions]);

  const visibleEvents = useMemo(() => {
    const now = Date.now();
    return decoratedEvents.filter((e) => eventMatchesFilter(e, filter, visibleLeafSessions, now)).slice(0, 20);
  }, [decoratedEvents, filter, visibleLeafSessions]);

  const setFilter = useCallback((patch: Partial<FilterConfig>) => {
    dispatch({ type: 'SET_FILTER', patch });
    const next: FilterConfig = { ...filter, ...patch };
    const qs = filterToParams(next).toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [filter, router, pathname]);

  const selectSession = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT_SESSION', id });
  }, []);

  return {
    sessions: allSessions,
    sessionsTotal: state.sessionsTotal,
    liveSessionCount: state.sessions.length,
    events: decoratedEvents,
    costs: state.costs,
    filter,
    selectedSessionId: state.selectedSessionId,
    availableAgents,
    visibleSessions,
    visibleEvents,
    setFilter,
    selectSession,
    hasSessionsLoaded: state.hasSessionsLoaded,
    hasCostLoaded: state.hasCostLoaded,
  };
}
