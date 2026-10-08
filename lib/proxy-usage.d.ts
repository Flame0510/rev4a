/** Types for the CommonJS proxy metering helpers shared with daemon.js. */

export const AGENT_HEADER: string;
export const UNKNOWN_AGENT: string;
export const ASSISTANT_AGENT: string;
export const HOUR_S: number;
export const PROXY_USAGE_RETENTION_MS: number;
export const CREATE_TABLE_SQL: string;
export const UPSERT_SQL: string;

/** Tokens of one call; `prompt` includes the `cached` part. */
export interface ProxyUsage {
  prompt: number;
  completion: number;
  cached: number;
}

/** $ per 1M tokens, as priceAt() returns them. */
export interface ProxyRates {
  input: number;
  output: number;
  cacheRead?: number;
}

/** One row's worth of increments for proxy_usage_hourly. */
export interface ProxyUsageEntry {
  hour: number;
  agent: string;
  provider: string;
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  errors: number;
  no_usage: number;
  cost: number;
}

export interface SseUsageParser {
  push(text: string): void;
  end(): ProxyUsage | null;
}

export function hourBucket(ms: number): number;
export const KNOWN_AGENTS_TTL_MS: number;
export const MAX_UNVERIFIED_IDS_PER_HOUR: number;
export function parseAgentHeader(value: unknown): string;
export function createAgentResolver(opts: {
  loadKnown: () => Iterable<string>;
  now?: () => number;
  ttlMs?: number;
  maxUnverified?: number;
}): (headerValue: unknown) => string;
export function extractUsage(json: unknown): ProxyUsage | null;
export function usageFromBody(text: string): ProxyUsage | null;
export function createSseUsageParser(): SseUsageParser;
export function costAt(usage: ProxyUsage | null, rates: ProxyRates | null): number;
export function buildEntry(call: {
  atMs: number;
  agent: string;
  provider: string;
  model: string;
  status: number;
  usage: ProxyUsage | null;
  rates: ProxyRates | null;
}): ProxyUsageEntry;
