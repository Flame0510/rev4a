/**
 * Olympus Provider Gateway — v1
 *
 * OpenAI-compatible chat completions endpoint.
 * POST /api/provider/v1/chat/completions
 *
 * Authentication uses provider keys stored in data/provider-keys.json.
 * The Authorization Bearer token must match a configured provider key.
 * The olympus master key (OLYMPUS_API_KEY env var) unlocks all providers.
 */
import { NextRequest } from 'next/server';
import { readProviderKeys } from '@/app/api/gateway/provider/keys';
import {
  extractProviderAndModel,
  getApiKey,
  callUpstream,
} from '@/app/api/provider/upstream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ProviderV1Request {
  model?: string;
  provider?: string;
  messages?: { role: string; content: string }[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

/** Serialize to JSON and return a Response with explicit Content-Length to avoid Traefik HTTP/2 issues. */
function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const body = JSON.stringify(data);
  const byteLen = Buffer.byteLength(body, 'utf-8');
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Content-Length': String(byteLen),
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    ...extraHeaders,
  });
  return new Response(body, { status, headers });
}

function errorResponse(message: string, type: string, status: number): Response {
  return jsonResponse({ error: { message, type } }, status);
}

export async function POST(request: NextRequest) {
  const start = Date.now();

  try {
    // Resolve provider from Authorization token
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const providerKeys = readProviderKeys();

    // Check if token matches any stored key
    const isAuthenticated = Object.values(providerKeys).some((key) => token === key);

    // Also accept the olympus master API key env var
    const olympusMasterKey = process.env.OLYMPUS_API_KEY;
    const isMasterAuth = !!olympusMasterKey && token === olympusMasterKey;

    if (!isAuthenticated && !isMasterAuth) {
      return errorResponse(
        'Invalid API key. Use your Olympus API key from the Gateway page via Authorization: Bearer <key>.',
        'authentication_error',
        401,
      );
    }

    const body: ProviderV1Request = await request.json();
    const { provider, model } = extractProviderAndModel(body);

    const apiKey = getApiKey(provider, providerKeys);
    if (!apiKey) {
      return errorResponse(
        `API key not configured for provider '${provider}'. Add it from the Gateway page.`,
        'configuration_error',
        401,
      );
    }

    const upstreamResp = await callUpstream(provider, model, body, apiKey);
    const latency = Date.now() - start;

    // Streaming passthrough
    if (upstreamResp.headers.get('content-type')?.includes('text/event-stream') || body.stream) {
      const responseHeaders = new Headers();
      upstreamResp.headers.forEach((value, key) => {
        const forbidden = ['transfer-encoding', 'connection', 'keep-alive', 'content-length'];
        if (!forbidden.includes(key.toLowerCase())) {
          responseHeaders.set(key, value);
        }
      });
      responseHeaders.set('x-olympus-gateway', 'true');
      responseHeaders.set('x-olympus-provider', provider);
      responseHeaders.set('x-olympus-latency-ms', String(latency));
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: responseHeaders,
      });
    }

    // Non-streaming: parse upstream JSON
    const responseText = await upstreamResp.text();
    let responseJson: Record<string, unknown> = {};
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = { raw: responseText };
    }

    // Build with explicit Content-Length (in bytes, not chars)
    const finalBodyStr = JSON.stringify(
      { ...responseJson, _gateway: { provider, latencyMs: latency, timestamp: Date.now() } },
    );
    const byteLen = Buffer.byteLength(finalBodyStr, 'utf-8');

    const responseHeaders = new Headers({
      'Content-Type': 'application/json',
      'Content-Length': String(byteLen),
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    });
    upstreamResp.headers.forEach((value, key) => {
      const forbidden = ['transfer-encoding', 'connection', 'keep-alive', 'content-length'];
      if (!forbidden.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });
    responseHeaders.set('x-olympus-gateway', 'true');
    responseHeaders.set('x-olympus-provider', provider);
    responseHeaders.set('x-olympus-latency-ms', String(latency));

    return new Response(finalBodyStr, {
      status: upstreamResp.status,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[provider/v1] Error:', message);
    return errorResponse(`Gateway error: ${message}`, 'gateway_error', 502);
  }
}
