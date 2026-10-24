/** Types for the CommonJS spend and loop alarms shared by daemon.js and the snooze API. */
import type Database from 'better-sqlite3';

export type SpendRule = 'session' | 'loop' | 'unusual' | 'unaccounted';

export interface SpendConfig {
  enabled: boolean;
  sessionShare: number;
  sessionClearShare: number;
  sessionFallbackTokens: number;
  sessionWindowMs: number;
  loopMinFailures: number;
  loopMinShare: number;
  loopMinPromptTokens: number;
  dayRatio: number;
  dayFloorUsd: number;
  dayFloorTokens: number;
  dayNewFloorUsd: number;
  dayNewFloorTokens: number;
  dayMinActiveDays: number;
  dayCooldownMs: number;
  dayNewCooldownMs: number;
  unaccountedRatio: number;
  unaccountedMinUsd: number;
  unaccountedRepeatCooldownMs: number;
  cooldownMs: number;
}

export interface SpendEvent {
  rule: SpendRule;
  metric: string;
  /** What the cooldown and a snooze key on: an agent id, `vendor:<name>` or `<container>:<session key>`. */
  scope: string;
  agent: string | null;
  container: string | null;
  vendor: string | null;
  session_key: string | null;
  hour: number;
  message: string;
  values: number[];
  threshold: number | null;
  resolved: boolean;
}

export const RULES: SpendRule[];
export const METRIC: Record<SpendRule, string>;
export const KIND_STATE: string;
export const KIND_HOUR: string;
export const KIND_SNOOZE: string;
export const DEFAULT_SNOOZE_HOURS: number;

export function configFromEnv(env?: Record<string, string | undefined>): SpendConfig;
export function hourOf(nowMs: number): number;
export function median(values: number[]): number;
export function isValidScope(scope: unknown): scope is string;
export function snooze(stateDb: Database.Database, scope: string, hours?: number, nowMs?: number): number;
export function activeSnoozes(stateDb: Database.Database, nowMs?: number): Map<string, number>;
export function markMeteringGap(costsDbPath: string, atMs?: number): void;
export function readMeteringGap(costsDbPath: string): number;
export function gapPathFor(costsDbPath: string): string;
export function gapHours(gapAtMs: number): number[];
export function sessionLevels(contextTokens: number | null | undefined, cfg: SpendConfig): { limit: number; fire: number; clear: number };
export function runSpendPass(deps: {
  costsDb: Database.Database;
  stateDb: Database.Database;
  nowMs?: number;
  config?: SpendConfig;
  gapAtMs?: number;
  resolveContainer?: (agent: string) => string | null;
  /** Called for each alarm before its state is written; a throw leaves no cooldown. Without it the events are returned. */
  deliver?: (event: SpendEvent) => void;
  /** A delivery that threw: nothing was stored for that alarm and the pass goes on. */
  onError?: (error: Error, event: Partial<SpendEvent>) => void;
}): SpendEvent[];
