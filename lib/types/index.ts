// Core domain types for Rev4a

/** What OpenClaw reports for a session ('' when it reports nothing: cron roots, never-run sessions). */
export type SessionStatus = 'running' | 'done' | 'failed' | 'aborted' | '';

/** What the UI shows: derived from the status, never guessed from the key or the clock. */
export type SessionState = 'working' | 'idle' | 'error' | 'done' | 'aborted';

/**
 * One OpenClaw session of one agent container (a row of `agent_sessions`). The identity is
 * `uid` = `<container>|<session_key>`: two containers can hold the same key (agent:main:main).
 * All timestamps are milliseconds.
 */
export interface Session {
  uid: string;
  container: string;
  agent_name: string | null;
  session_key: string;
  session_id: string | null;
  /** main | subagent | cron | cron_run | explicit | custom | direct | dashboard */
  kind: string;
  /** uid of the parent, only when the parent row exists in the same container. */
  parent_uid: string | null;
  /** 'spawn' (real sub-agent link), 'cron' (a run of a job) or 'nav' (navigation only). */
  parent_kind: string | null;
  spawn_depth: number | null;
  label: string | null;
  status: SessionStatus;
  last_error: string | null;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  /** null when OpenClaw has no price for the model: shown as "not priced", never as $0. */
  cost_usd: number | null;
  cron_job_id: string | null;
  started_at: number | null;
  updated_at: number | null;
  ended_at: number | null;
  archived_at: number | null;
  /** Set when the container is gone or stopped, or the row left the list. */
  gone_at: number | null;
}

export interface SessionDetail {
  session: Session;
  events: SessionEvent[];
  children: Session[];
}

export interface SessionEvent {
  id?: string | number;
  /** Milliseconds. */
  ts?: number;
  type?: string;
  event?: string;
  data?: unknown;
  /** The session key (events.session_id). */
  session_id?: string;
  session_label?: string;
  label?: string;
  container?: string;
  agent_name?: string;
}

export interface Costs {
  today: number;
  allTime: number;
  allTimeSource?: string;
  byModel: ModelCost[];
}

export interface ModelCost {
  model: string;
  cost_usd: number;
  tokens_in?: number;
  tokens_out?: number;
  sessions?: number;
}

// SSE streaming message shapes
export type StreamMessage =
  | { type: 'sessions'; data: unknown[] | { sessions?: unknown[] }; total?: number }
  | { type: 'events'; data: unknown[] }
  | { type: 'costs'; data: { today?: number } };

// Filter configuration. `agent` is a container name, or 'all'.
export interface FilterConfig {
  agent: string;
  showOnlyActive: boolean;
  showCron: boolean;
  period: Period;
}

export type Period = '1d' | '3d' | '7d' | '15d' | '30d' | 'all';

export const PERIODS: Period[] = ['1d', '3d', '7d', '15d', '30d', 'all'];

export { PERIOD_MS } from '../patterns/sessionPresentation';

/** An agent the toolbar can filter on. `value` is the docker container name. */
export interface AgentOption {
  value: string;
  label: string;
  running: boolean;
}

// Tree node for SessionTopology (D3)
export interface TreeNode {
  /** Session uid, `__agent__:<container>` for a container, `__root__` for the virtual root. */
  uid: string;
  name: string;
  state: SessionState;
  kind?: string;
  container?: string;
  model?: string | null;
  cost_usd?: number | null;
  stopped?: boolean;
  /** A short note about where the session really came from, e.g. 'from a cron run' when cron is hidden. */
  hint?: string;
  children?: TreeNode[];
  _virtualRoot?: boolean;
  _agentNode?: boolean;
}
