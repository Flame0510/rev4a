// Factory pattern: creates canonical Session objects from unknown raw input
import type { Session, SessionEvent } from '../types';
import { adaptSession, adaptEvent } from './ApiAdapter';

export { buildSessionTree } from './sessionPresentation';

/** Produces normalized Session instances from arbitrary raw data. */
export class SessionFactory {
  static create(raw: unknown): Session {
    return adaptSession(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {});
  }

  static createMany(raws: unknown[]): Session[] {
    return raws.map(SessionFactory.create).filter((s) => s.uid !== '');
  }
}

/** Produces normalized SessionEvent instances from arbitrary raw data. */
export class EventFactory {
  static create(raw: unknown): SessionEvent {
    if (!raw || typeof raw !== 'object') return {};
    return adaptEvent(raw as Record<string, unknown>);
  }

  static createMany(raws: unknown[]): SessionEvent[] {
    return raws.map(EventFactory.create);
  }
}
