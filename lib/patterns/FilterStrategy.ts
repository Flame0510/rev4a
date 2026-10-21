// Strategy pattern: interchangeable session filter algorithms
import type { Session, FilterConfig, Period } from '../types';
import { isCronSession, isSessionActive, periodCutoff } from './sessionPresentation';

/** Base interface — every filter strategy must implement this. */
export interface IFilterStrategy {
  filter(sessions: Session[]): Session[];
}

// ── Concrete strategies ────────────────────────────────────────────────────

/** Keeps one container's sessions ('all' keeps everything). */
export class AgentFilterStrategy implements IFilterStrategy {
  constructor(private readonly container: string) {}

  filter(sessions: Session[]): Session[] {
    if (this.container === 'all') return sessions;
    return sessions.filter((s) => s.container === this.container);
  }
}

export class ActiveOnlyFilterStrategy implements IFilterStrategy {
  filter(sessions: Session[]): Session[] {
    return sessions.filter(isSessionActive);
  }
}

export class NoCronFilterStrategy implements IFilterStrategy {
  filter(sessions: Session[]): Session[] {
    return sessions.filter((s) => !isCronSession(s));
  }
}

/** A session that is working stays whatever its age. */
export class PeriodFilterStrategy implements IFilterStrategy {
  private readonly cutoff: number;

  constructor(period: Period, now = Date.now()) {
    this.cutoff = periodCutoff(period, now);
  }

  filter(sessions: Session[]): Session[] {
    if (this.cutoff === 0) return sessions;
    return sessions.filter((s) => {
      if (isSessionActive(s)) return true;
      const latest = Math.max(Number(s.started_at ?? 0), Number(s.updated_at ?? 0));
      return latest >= this.cutoff;
    });
  }
}

// ── Composite strategy ─────────────────────────────────────────────────────

/** Chains multiple strategies, applying each in sequence. */
export class CompositeFilterStrategy implements IFilterStrategy {
  private readonly strategies: IFilterStrategy[];

  constructor(strategies: IFilterStrategy[]) {
    this.strategies = strategies;
  }

  filter(sessions: Session[]): Session[] {
    return this.strategies.reduce((acc, s) => s.filter(acc), sessions);
  }
}

// ── Factory for building the composite from a FilterConfig ────────────────

export function buildFilterStrategy(config: FilterConfig, now = Date.now()): IFilterStrategy {
  const strategies: IFilterStrategy[] = [
    new AgentFilterStrategy(config.agent),
    new PeriodFilterStrategy(config.period, now),
  ];

  if (config.showOnlyActive) strategies.push(new ActiveOnlyFilterStrategy());
  if (!config.showCron) strategies.push(new NoCronFilterStrategy());

  return new CompositeFilterStrategy(strategies);
}
