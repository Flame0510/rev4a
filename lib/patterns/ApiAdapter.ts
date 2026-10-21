// Adapter pattern: normalizes raw API shapes into domain types.
// Type imports only: scripts/test-lineage-ui.mjs runs this file in Node.
import type { Session, SessionStatus, SessionEvent, Costs, ModelCost } from '../types';

const STATUSES = new Set<SessionStatus>(['running', 'done', 'failed', 'aborted', '']);

function toStatus(raw: unknown): SessionStatus {
  const s = String(raw ?? '').trim().toLowerCase();
  return STATUSES.has(s as SessionStatus) ? (s as SessionStatus) : '';
}

function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Milliseconds; a value below 1e11 can only be seconds. null when absent. */
function toTimeMs(raw: unknown): number | null {
  const n = toNumber(raw);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : n;
}

function toString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  return s === '' ? null : s;
}

/** Adapts a raw API session (the `Session` of GET /api/sessions) into the canonical shape. */
export function adaptSession(raw: Record<string, unknown>): Session {
  const container = String(raw.container ?? '');
  const session_key = String(raw.session_key ?? raw.id ?? raw.session_id ?? '');
  const uid = String(raw.uid ?? (container || session_key ? `${container}|${session_key}` : ''));
  // An older server sends parent_id (a key) only: the parent is in the same container.
  const legacyParent = toString(raw.parent_id);
  const parent_uid =
    raw.parent_uid !== undefined
      ? toString(raw.parent_uid)
      : legacyParent && container
        ? `${container}|${legacyParent}`
        : null;
  return {
    uid,
    container,
    agent_name: toString(raw.agent_name),
    session_key,
    session_id: toString(raw.session_id && raw.session_id !== session_key ? raw.session_id : null),
    kind: String(raw.kind ?? ''),
    parent_uid,
    parent_kind: toString(raw.parent_kind),
    spawn_depth: toNumber(raw.spawn_depth),
    label: toString(raw.label),
    status: toStatus(raw.status),
    last_error: toString(raw.last_error),
    model: toString(raw.model),
    provider: toString(raw.provider),
    input_tokens: toNumber(raw.input_tokens),
    output_tokens: toNumber(raw.output_tokens),
    total_tokens: toNumber(raw.total_tokens),
    // null stays null: an unpriced session is "not priced", never $0.
    cost_usd: toNumber(raw.cost_usd),
    cron_job_id: toString(raw.cron_job_id),
    started_at: toTimeMs(raw.started_at),
    updated_at: toTimeMs(raw.updated_at),
    ended_at: toTimeMs(raw.ended_at),
    archived_at: toTimeMs(raw.archived_at),
    gone_at: toTimeMs(raw.gone_at),
  };
}

/** Adapts a raw event object. `ts` is milliseconds. */
export function adaptEvent(raw: Record<string, unknown>): SessionEvent {
  return {
    id: (raw.id as string | number | undefined) ?? undefined,
    ts: toTimeMs(raw.ts) ?? undefined,
    type: toString(raw.type ?? raw.event) ?? undefined,
    event: toString(raw.event) ?? undefined,
    data: raw.data,
    session_id: toString(raw.session_id ?? raw.session_key) ?? undefined,
    session_label: toString(raw.session_label ?? raw.label) ?? undefined,
    container: toString(raw.container) ?? undefined,
    agent_name: toString(raw.agent_name) ?? undefined,
  };
}

/** Adapts a raw costs API response. */
export function adaptCosts(raw: Record<string, unknown>): Costs {
  const byModel: ModelCost[] = Array.isArray(raw.byModel)
    ? (raw.byModel as Record<string, unknown>[]).map((m) => ({
        model: String(m.model ?? 'unknown'),
        cost_usd: toNumber(m.cost_usd) ?? 0,
        tokens_in: toNumber(m.tokens_in) ?? undefined,
        tokens_out: toNumber(m.tokens_out) ?? undefined,
        sessions: toNumber(m.sessions) ?? undefined,
      }))
    : [];

  return {
    today: toNumber(raw.today) ?? 0,
    allTime: toNumber(raw.allTime) ?? 0,
    allTimeSource: toString(raw.allTimeSource) ?? undefined,
    byModel,
  };
}
