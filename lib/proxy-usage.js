'use strict';

/**
 * Metering at the Rev4a provider proxy. Helpers with no I/O (all pure, except that
 * createAgentResolver reads Date.now unless it is given a clock) shared by the proxy route
 * (through app/api/provider/upstream.ts) and daemon.js (table and retention). The Costs page
 * reads the table in lib/agent-costs.ts. The proxy sees every request and every upstream usage block, so
 * it is the meter that does not depend on what an agent chose to record: a call whose
 * context compaction failed is in the proxy's figures and not in OpenClaw's.
 *
 * One row per hour, agent, provider and model in costs.db, `proxy_usage_hourly`.
 */

const { markMeteringGap } = require('./spend-alerts.js');

/** Header every agent sends (models.providers.rev4a.headers, written by every sync and every per-agent patch). */
const AGENT_HEADER = 'x-rev4a-agent';
/** A request without the header, or with one that is not an agent id. */
const UNKNOWN_AGENT = 'unknown';
/** The Rev4a assistant calls upstream directly, not through HTTP; it is metered under this name. */
const ASSISTANT_AGENT = 'assistant';
const HOUR_S = 3600;
/** Same as the vendor balance readings: 400 days. */
const PROXY_USAGE_RETENTION_MS = 400 * 24 * 3600 * 1000;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A single SSE line longer than this is dropped rather than buffered without limit. */
const MAX_LINE_CHARS = 1024 * 1024;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS proxy_usage_hourly (
  hour INTEGER NOT NULL,
  agent TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  no_usage INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, agent, provider, model)
)`;

const UPSERT_SQL = `
INSERT INTO proxy_usage_hourly (hour, agent, provider, model, calls, prompt_tokens, completion_tokens,
  cached_tokens, errors, no_usage, cost)
VALUES (@hour, @agent, @provider, @model, @calls, @prompt_tokens, @completion_tokens,
  @cached_tokens, @errors, @no_usage, @cost)
ON CONFLICT(hour, agent, provider, model) DO UPDATE SET
  calls = calls + excluded.calls,
  prompt_tokens = prompt_tokens + excluded.prompt_tokens,
  completion_tokens = completion_tokens + excluded.completion_tokens,
  cached_tokens = cached_tokens + excluded.cached_tokens,
  errors = errors + excluded.errors,
  no_usage = no_usage + excluded.no_usage,
  cost = cost + excluded.cost`;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Start of the UTC hour containing `ms`, in epoch seconds. */
function hourBucket(ms) {
  return Math.floor(ms / 1000 / HOUR_S) * HOUR_S;
}

/**
 * The agent a request names, or 'unknown' for a missing, repeated or malformed header.
 * 'assistant' and 'unknown' are reserved (the assistant route meters itself, internally):
 * a header that claims either is not accepted.
 */
function parseAgentHeader(value) {
  if (typeof value !== 'string') return UNKNOWN_AGENT;
  const v = value.trim();
  const lower = v.toLowerCase();
  if (!AGENT_ID_RE.test(v) || lower === ASSISTANT_AGENT || lower === UNKNOWN_AGENT) return UNKNOWN_AGENT;
  return v;
}

/** How long the set of known agents is kept before it is read again. */
const KNOWN_AGENTS_TTL_MS = 60_000;
/** Distinct ids not (yet) in the known set accepted per process per hour. */
const MAX_UNVERIFIED_IDS_PER_HOUR = 200;

/**
 * Decides which agent id a request is metered under, so a holder of the gateway key cannot
 * create rows at will. A valid id is always accepted when it is a known agent (`loadKnown`
 * returns the agent_id and container values Rev4a already has; it is called at most every
 * KNOWN_AGENTS_TTL_MS and may throw). Any other valid id — a new agent the daemon has not
 * read yet, or none can be read — is accepted up to MAX_UNVERIFIED_IDS_PER_HOUR distinct
 * ones per hour; beyond that it is 'unknown'.
 * @param {{ loadKnown: () => Iterable<string>, now?: () => number,
 *   ttlMs?: number, maxUnverified?: number }} opts
 */
function createAgentResolver(opts) {
  const now = opts.now || Date.now;
  const ttl = opts.ttlMs ?? KNOWN_AGENTS_TTL_MS;
  const cap = opts.maxUnverified ?? MAX_UNVERIFIED_IDS_PER_HOUR;
  let known = new Set();
  let loadedAt = -Infinity;
  let hour = -1;
  let seen = new Set();

  return function resolve(headerValue) {
    const id = parseAgentHeader(headerValue);
    if (id === UNKNOWN_AGENT) return id;
    const t = now();
    if (t - loadedAt >= ttl || t < loadedAt) {
      loadedAt = t;
      try {
        known = new Set(opts.loadKnown());
      } catch {
        known = new Set();
      }
    }
    if (known.has(id)) return id;
    const h = hourBucket(t);
    if (h !== hour) {
      hour = h;
      seen = new Set();
    }
    if (seen.has(id)) return id;
    if (seen.size >= cap) return UNKNOWN_AGENT;
    seen.add(id);
    return id;
  };
}

/**
 * Tokens from an OpenAI-compatible `usage` block, or null when there is none. The cached
 * count is read where the vendors put it: `prompt_tokens_details.cached_tokens` (OpenAI,
 * OpenRouter, most), `prompt_cache_hit_tokens` (DeepSeek). `prompt` includes the cached part.
 * @returns {{ prompt: number, completion: number, cached: number } | null}
 */
function extractUsage(json) {
  const u = json && typeof json === 'object' ? json.usage : null;
  if (!u || typeof u !== 'object') return null;
  const prompt = isNum(u.prompt_tokens) ? u.prompt_tokens : isNum(u.input_tokens) ? u.input_tokens : null;
  const completion = isNum(u.completion_tokens) ? u.completion_tokens : isNum(u.output_tokens) ? u.output_tokens : null;
  if (prompt === null && completion === null) return null;
  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {};
  const cachedRaw = isNum(details.cached_tokens) ? details.cached_tokens
    : isNum(u.prompt_cache_hit_tokens) ? u.prompt_cache_hit_tokens
    : isNum(u.cached_tokens) ? u.cached_tokens : 0;
  const p = prompt ?? 0;
  return { prompt: p, completion: completion ?? 0, cached: Math.min(cachedRaw, p) };
}

/** Usage from a complete JSON response body, or null (not JSON, or no usage block). */
function usageFromBody(text) {
  try {
    return extractUsage(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Reads usage out of an SSE stream as it passes, without keeping it: lines can arrive split
 * across chunks, so only the unfinished tail of the last line is held. The last `usage` block
 * seen wins (providers send it once, in the final data chunk).
 */
function createSseUsageParser() {
  let tail = '';
  let usage = null;

  function line(raw) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (!data || data === '[DONE]') return;
    // Cheap test before parsing every content chunk.
    if (!data.includes('"usage"')) return;
    try {
      const found = extractUsage(JSON.parse(data));
      if (found) usage = found;
    } catch { /* not JSON: ignore */ }
  }

  return {
    push(text) {
      const parts = (tail + text).split('\n');
      tail = parts.pop() ?? '';
      if (tail.length > MAX_LINE_CHARS) tail = '';
      for (const p of parts) line(p);
    },
    /** Flush the last line (no trailing newline) and return what was seen. */
    end() {
      if (tail) line(tail);
      tail = '';
      return usage;
    },
  };
}

/**
 * Cost in dollars of one call at the given rates ($ per 1M tokens), which the caller took
 * from priceAt() at the time of the call. Cached prompt tokens at the cache rate, the rest
 * of the prompt at the input rate. No rates (unpriced model) or no usage: 0.
 */
function costAt(usage, rates) {
  if (!usage || !rates) return 0;
  const cached = Math.min(usage.cached, usage.prompt);
  const cost = ((usage.prompt - cached) * rates.input + cached * (isNum(rates.cacheRead) ? rates.cacheRead : rates.input)
    + usage.completion * rates.output) / 1e6;
  return Number.isFinite(cost) ? cost : 0;
}

/**
 * The row to add for one finished call.
 * @param {{ atMs: number, agent: string, provider: string, model: string, status: number,
 *   usage: { prompt: number, completion: number, cached: number } | null,
 *   rates: { input: number, output: number, cacheRead?: number } | null }} call
 */
function buildEntry(call) {
  const failed = !(call.status >= 200 && call.status < 300);
  const usage = call.usage;
  return {
    hour: hourBucket(call.atMs),
    agent: call.agent,
    provider: call.provider,
    model: call.model,
    calls: 1,
    prompt_tokens: usage ? usage.prompt : 0,
    completion_tokens: usage ? usage.completion : 0,
    cached_tokens: usage ? usage.cached : 0,
    errors: failed ? 1 : 0,
    // A successful call that reported nothing (a stream cut before its last chunk).
    no_usage: !failed && !usage ? 1 : 0,
    cost: costAt(usage, call.rates),
  };
}

module.exports = {
  /** Leaves the moment metering was paused where the daemon's spend alarms read it (lib/spend-alerts.js). */
  markMeteringGap,
  AGENT_HEADER,
  UNKNOWN_AGENT,
  ASSISTANT_AGENT,
  HOUR_S,
  PROXY_USAGE_RETENTION_MS,
  CREATE_TABLE_SQL,
  UPSERT_SQL,
  hourBucket,
  parseAgentHeader,
  KNOWN_AGENTS_TTL_MS,
  MAX_UNVERIFIED_IDS_PER_HOUR,
  createAgentResolver,
  extractUsage,
  usageFromBody,
  createSseUsageParser,
  costAt,
  buildEntry,
};
