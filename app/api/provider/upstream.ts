/**
 * Olympus Provider Gateway — upstream logic
 *
 * Shared logic for calling upstream AI providers.
 * Used by both /api/provider/v1/chat/completions and /api/assistant
 * to avoid HTTP loopback (calling localhost from inside Next.js).
 */
export const dynamic = 'force-dynamic';

export const PROVIDER_ENVS: Record<string, { baseUrl: string; authHeader: string }> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    authHeader: 'Authorization',
  },
  'openai-codex': {
    baseUrl: 'https://api.openai.com',
    authHeader: 'Authorization',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    authHeader: 'Authorization',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    authHeader: 'Authorization',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai',
    authHeader: 'Authorization',
  },
};

/** Map olympus/ model aliases to upstream provider/model pairs. */
export const MODEL_ALIASES: Record<string, { provider: string; model: string }> = {
  'olympus/deepseek-v4-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' },
  'olympus/deepseek-v4-pro': { provider: 'deepseek', model: 'deepseek-v4-pro' },
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
  // Check aliases first (olympus/deepseek-v4-flash -> deepseek/deepseek-v4-flash)
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

  const targetUrl = `${envConfig.baseUrl}/v1/chat/completions`;

  const upstreamBody: Record<string, unknown> = { ...body, model: model || undefined };
  delete upstreamBody.provider;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (envConfig.authHeader === 'x-api-key') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://olympus.example.com';
    headers['X-Title'] = 'Olympus Gateway';
  }

  // Force identity encoding to avoid gzip-related HTTP/2 truncation issues via Traefik
  headers['Accept-Encoding'] = 'identity';

  return fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(upstreamBody),
  });
}
