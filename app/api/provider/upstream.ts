/**
 * Rev4a Provider Gateway — upstream logic
 *
 * Shared logic for calling upstream AI providers.
 * Used by both /api/provider/v1/chat/completions and /api/assistant
 * to avoid HTTP loopback (calling localhost from inside Next.js).
 */
import Database from 'better-sqlite3';
import { COSTS_DB_PATH } from '@/lib/costs-db';
import { priceAt } from '@/lib/model-pricing';
import {
  CREATE_TABLE_SQL,
  UPSERT_SQL,
  buildEntry,
  createAgentResolver,
  createSseUsageParser,
  markMeteringGap,
  usageFromBody,
  type ProxyUsage,
} from '@/lib/proxy-usage';

export const dynamic = 'force-dynamic';

export interface ProviderEnvConfig {
  baseUrl: string;
  authHeader: string;
  /** Path prefix for chat completions (defaults to "/v1" if omitted). */
  basePath?: string;
}

export const PROVIDER_ENVS: Record<string, ProviderEnvConfig> = {
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHeader: 'x-goog-api-key',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    authHeader: 'Authorization',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    authHeader: 'Authorization',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    authHeader: 'Authorization',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai',
    authHeader: 'Authorization',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn',
    authHeader: 'Authorization',
  },
  glm: {
    baseUrl: 'https://api.z.ai',
    basePath: '/api/paas/v4',
    authHeader: 'Authorization',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com',
    basePath: '/compatible-mode/v1',
    authHeader: 'Authorization',
  },
};

/** Map rev4a/ model aliases to upstream provider/model pairs. */
export const MODEL_ALIASES: Record<string, { provider: string; model: string }> = {
  'rev4a/deepseek-flash': { provider: 'deepseek', model: 'deepseek-flash' },
  'rev4a/deepseek-v4-pro': { provider: 'deepseek', model: 'deepseek-v4-pro' },
};

export interface UpstreamRequest {
  model?: string;
  provider?: string;
  messages?: { role: string; content: string }[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export function extractProviderAndModel(request: UpstreamRequest): { provider: string; model: string } {
  const modelStr = request.model || '';
  if (request.provider) {
    return { provider: request.provider, model: modelStr };
  }
  // Check aliases first (rev4a/deepseek-flash -> deepseek/deepseek-flash)
  if (modelStr && MODEL_ALIASES[modelStr]) {
    return { ...MODEL_ALIASES[modelStr] };
  }
  const parts = modelStr.split('/');
  if (parts.length >= 2 && PROVIDER_ENVS[parts[0]]) {
    return { provider: parts[0], model: parts.slice(1).join('/') };
  }
  // Default fallback: assume the model is a raw upstream model ID
  if (parts.length >= 3 && PROVIDER_ENVS[parts[1]]) {
    return { provider: parts[1], model: parts.slice(2).join('/') };
  }
  return { provider: 'deepseek', model: modelStr || 'deepseek-chat' };
}

export function getApiKey(provider: string, storedKeys: Record<string, string>): string | null {
  return storedKeys[provider] || null;
}

/** Only diagnostic identifiers may reach logs; fetch messages can contain credentials. */
export function upstreamErrorDetails(error: unknown): { name: string; code?: string | number; cause?: string } {
  const err = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
  return {
    name: identifier(err?.name) ? err.name : 'Error',
    ...(identifier(err?.code) || typeof err?.code === 'number' ? { code: err.code } : {}),
    // undici's "fetch failed" keeps the reason (ECONNREFUSED, ENOTFOUND, ...) in cause.code.
    ...(identifier(err?.cause?.code) ? { cause: err.cause.code } : {}),
  };
}

export async function callUpstream(
  provider: string,
  model: string,
  body: UpstreamRequest,
  apiKey: string,
): Promise<Response> {
  const envConfig = PROVIDER_ENVS[provider];
  if (!envConfig) {
    return new Response(
      JSON.stringify({ error: { message: `Unknown provider: ${provider}`, type: 'invalid_request_error' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Old vaults can contain malformed keys. Fail before building any headers or calling fetch.
  if (/[\x00-\x1f\x7f]/.test(apiKey)) throw new TypeError('Invalid upstream API key');

  const basePath = envConfig.basePath || '/v1';
  const targetUrl = `${envConfig.baseUrl}${basePath}/chat/completions`;

  const upstreamBody: Record<string, unknown> = { ...body, model: model || undefined };
  delete upstreamBody.provider;
  // `model` has been checked against the catalogue; these fields let the upstream
  // pick a different one. OpenRouter serves a fallback from `models` when the
  // primary fails, and `route`/`preset` can redirect the request, so forwarding them
  // would let a client get a model the catalogue does not offer.
  delete upstreamBody.models;
  delete upstreamBody.route;
  delete upstreamBody.preset;

  // A stream carries its usage only in a final chunk the client has to ask for. The proxy
  // asks for it itself so every streamed call can be metered (see meterStream); the chunk is
  // a standard OpenAI one with an empty `choices`, and is forwarded to the client with the rest.
  if (upstreamBody.stream === true) {
    const so = upstreamBody.stream_options;
    upstreamBody.stream_options = { ...(so && typeof so === 'object' ? so : {}), include_usage: true };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (envConfig.authHeader === 'x-api-key') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  if (provider === 'openrouter') {
    // Attribution only: OpenRouter uses this pair to identify the app on its
    // public leaderboard. It never resolves or contacts the URL, and it has no
    // effect on routing, rate limits, pricing, or whether the call succeeds.
    //
    // This used to be `http://${detectPublicHost()}:3740`, which shelled out to
    // curl synchronously — blocking the whole event loop for ~270ms before every
    // OpenRouter call, and 55 of the 69 models enabled in the catalogue are
    // OpenRouter ones. It also fragmented the attribution it was supposed to
    // provide: every install reported a different host, so each one showed up as
    // a separate app. A per-install address was never the right value here —
    // X-Title, the other half of the same label, was always a constant.
    headers['HTTP-Referer'] = 'https://rev4a.app';
    headers['X-Title'] = 'Rev4a Gateway';
  }

  // Force identity encoding to avoid gzip-related HTTP/2 truncation issues via Traefik
  headers['Accept-Encoding'] = 'identity';

  return fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(upstreamBody),
  });
}

/* ------------------------------------------------------------------ */
/*  Metering — what the proxy saw, per agent, hour and model           */
/* ------------------------------------------------------------------ */

/** Who made a call and what it asked for; the metering key. */
export interface MeterContext {
  agent: string;
  provider: string;
  model: string;
  /** Start of the call: the hour it is counted in and the moment its price is taken at. */
  startMs: number;
}

interface UsageStore {
  db: Database.Database;
  insert: Database.Statement;
}
let usageStore: UsageStore | null = null;
/** After a failure (open or insert) metering is skipped until this moment. */
let usageStoreRetryAt = 0;

function pauseMetering(what: string, e: unknown): void {
  // Logged once per pause, not once per dropped call.
  if (Date.now() >= usageStoreRetryAt) console.error(`[provider/v1] ${what}:`, upstreamErrorDetails(e));
  usageStoreRetryAt = Date.now() + 60_000;
  // The spend alarms skip the hours this gap touches: dropped calls must never read as zero (lib/spend-alerts.js).
  markMeteringGap(COSTS_DB_PATH);
}

function openUsageStore(): UsageStore | null {
  if (Date.now() < usageStoreRetryAt) return null;
  if (usageStore) return usageStore;
  let db: Database.Database | null = null;
  try {
    // The daemon writes costs.db too. `timeout` is the busy timeout from the first statement
    // on (the pragmas and the CREATE included): a held lock costs at most about 200 ms.
    db = new Database(COSTS_DB_PATH, { timeout: 200 });
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(CREATE_TABLE_SQL);
    usageStore = { db, insert: db.prepare(UPSERT_SQL) };
    return usageStore;
  } catch (e) {
    // A pragma, the CREATE or the prepare threw: close the handle, or each retry leaks a descriptor.
    try { db?.close(); } catch { /* already closed */ }
    pauseMetering('metering store unavailable', e);
    return null;
  }
}

/**
 * agent_id and container values of the agents Rev4a knows (the daemon fills agent_cost_sources).
 * Prepared on each read (at most once a minute): before the daemon's first pass the table does
 * not exist, which must not stop the metering — the resolver treats the throw as "none known".
 */
function loadKnownAgents(): string[] {
  const store = openUsageStore();
  if (!store) return [];
  const ids: string[] = [];
  const rows = store.db.prepare('SELECT agent_id, container FROM agent_cost_sources').all();
  for (const r of rows as { agent_id: string | null; container: string | null }[]) {
    if (r.agent_id) ids.push(r.agent_id);
    if (r.container) ids.push(r.container);
  }
  return ids;
}

const agentResolver = createAgentResolver({ loadKnown: loadKnownAgents });

/**
 * The agent a request is metered under, from its `x-rev4a-agent` header: a known agent, or
 * 'unknown' (see createAgentResolver). Reads the known set at most once a minute and never
 * touches Docker.
 */
export function resolveMeterAgent(headerValue: string | null): string {
  return agentResolver(headerValue);
}

/**
 * Add one finished call to proxy_usage_hourly. Best effort and off the response path: a
 * metering failure is logged and never reaches the caller of the proxy.
 */
export function recordProxyCall(ctx: MeterContext, status: number, usage: ProxyUsage | null): void {
  setImmediate(() => {
    try {
      const store = openUsageStore();
      if (!store) return;
      let rates = null;
      try {
        rates = priceAt(`${ctx.provider}/${ctx.model}`, new Date(ctx.startMs));
      } catch { /* unpriced: counted, cost 0 */ }
      store.insert.run(buildEntry({ atMs: ctx.startMs, agent: ctx.agent, provider: ctx.provider, model: ctx.model, status, usage, rates }));
    } catch (e) {
      pauseMetering('metering write failed, pausing for 60 s', e);
    }
  });
}

/** Meter a complete (non-streaming) response body. */
export function meterBody(ctx: MeterContext, status: number, text: string): void {
  recordProxyCall(ctx, status, usageFromBody(text));
}

/**
 * Pass an SSE body through untouched and read its usage on the way: chunks are forwarded as
 * they arrive, never collected. The call is recorded once, when the stream ends, fails, or
 * the client goes away (what was seen until then is kept).
 */
export function meterStream(body: ReadableStream<Uint8Array>, ctx: MeterContext, status: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseUsageParser();
  let recorded = false;
  const finish = () => {
    if (recorded) return;
    recorded = true;
    let usage: ProxyUsage | null = null;
    try {
      parser.push(decoder.decode());
      usage = parser.end();
    } catch { /* keep what we have */ }
    recordProxyCall(ctx, status, usage);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        try {
          parser.push(decoder.decode(value, { stream: true }));
        } catch { /* metering never breaks the stream */ }
        controller.enqueue(value);
      } catch (e) {
        finish();
        console.error('[provider/v1] The upstream stream failed:', upstreamErrorDetails(e));
        controller.error(new Error('Gateway error: the upstream request failed'));
      }
    },
    async cancel(reason) {
      finish();
      try {
        await reader.cancel(reason);
      } catch { /* already closed */ }
    },
  });
}
