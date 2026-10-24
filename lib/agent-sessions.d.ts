/** Types for the CommonJS agent_sessions helpers shared with daemon.js. */

export interface AgentSessionRow {
  container: string;
  session_key: string;
  agent_name: string | null;
  session_id: string | null;
  kind: string | null;
  parent_key: string | null;
  parent_kind: string | null;
  spawn_depth: number | null;
  label: string | null;
  status: string | null;
  last_error: string | null;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  context_tokens: number | null;
  cost_usd: number | null;
  cron_job_id: string | null;
  started_at: number | null;
  updated_at: number | null;
  ended_at: number | null;
  archived_at: number | null;
  last_seen_at: number | null;
  gone_at: number | null;
}

export interface SessionEvent {
  ts: number;
  session_key: string;
  type: 'session_started' | 'subagent_spawned' | 'session_ended' | 'session_failed' | 'session_aborted';
  data: Record<string, unknown>;
}

export interface SessionDiff {
  rows: Array<{ row: AgentSessionRow; changed: boolean }>;
  events: SessionEvent[];
  gone: string[];
  changed: boolean;
}

export const CREATE_TABLES_SQL: string;
export const CONTENT_COLUMNS: string[];
export const ADDED_COLUMNS: [string, string][];
export function ensureAddedColumns(db: { prepare(sql: string): { all(): { name: string }[] }; exec(sql: string): unknown }): void;
export const ALL_COLUMNS: string[];
export const TERMINAL: Set<string>;
export const FRESH_EVENT_MS: number;
export const RETENTION_MS: number;
export const CRON_RETENTION_MS: number;
export const PAGE_LIMIT: number;
export const MAX_PAGES: number;

export function cronJobIdOf(key: unknown): string | null;
export function cronRootJobId(key: unknown): string | null;
export function kindFromKey(key: string): string;
export function normalizeStatus(raw: unknown, flags?: { aborted?: boolean; hasActiveRun?: boolean }): string;
export function mapListRow(raw: unknown, ctx: { container: string; agentName?: string | null }): AgentSessionRow | null;
export function parseListPage(answer: unknown): { sessions: unknown[]; hasMore: boolean; nextOffset: number | null; totalCount: number | null };
export function readAllSessions(
  fetchPage: (params: Record<string, unknown>) => Promise<unknown>,
  ctx: { container: string; agentName?: string | null },
): Promise<{ rows: AgentSessionRow[]; complete: boolean }>;
export function parseCronRuns(answer: unknown): unknown[];
export function validJobId(id: unknown): boolean;
export function mapCronRun(entry: unknown, jobId: string, ctx: { container: string; agentName?: string | null }): AgentSessionRow | null;
export function transitionEvents(prev: AgentSessionRow | null, next: AgentSessionRow, now: number, freshMs?: number): SessionEvent[];
export function diffSessions(
  stored: Map<string, AgentSessionRow>,
  incoming: AgentSessionRow[],
  now: number,
  opts?: { complete?: boolean; freshMs?: number },
): SessionDiff;
export function cronJobsToRead(
  storedRows: AgentSessionRow[],
  readAt: Map<string, number>,
  now: number,
  max: number,
  failed?: Map<string, { at: number; failures: number }>,
): Array<{ jobId: string; marker: number }>;
export function cronBackoffMs(failures: number): number;
export function nextDelayMs(anyRunning: boolean, failures?: number): number;
export const PRUNE_SQL: { sessions: string; cronRuns: string; cronJobs: string; cronEvents: string };
export function containersToMarkGone(storedContainers: Iterable<string>, liveContainers: Iterable<string>): string[];
