/**
 * Rev4a Provider Gateway — upstream logic
 *
 * Shared logic for calling upstream AI providers.
 * Used by both /api/provider/v1/chat/completions and /api/assistant
 * to avoid HTTP loopback (calling localhost from inside Next.js).
 */
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
