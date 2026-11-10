/**
 * Rev4a Provider Gateway — v1
 *
 * OpenAI-compatible chat completions endpoint.
 * POST /api/provider/v1/chat/completions
 *
 * Authentication accepts derived agent tokens, the shared gateway key, or REV4A_API_KEY.
 * See `app/api/provider/auth.ts` — in particular why the other entries in that
 * file, which are upstream credentials rather than passwords, must not be
 * accepted here.
 */
import { NextRequest } from 'next/server';
import { isGatewayClient } from '@/app/api/provider/auth';
import { isModelOffered } from '@/lib/model-catalogue';
import { readProviderKeys } from '@/app/api/gateway/provider/keys';
import {
  extractProviderAndModel,
  getApiKey,
  callUpstream,
  meterBody,
  meterStream,
  recordProxyCall,
  resolveMeterAgent,
  upstreamErrorDetails,
  type MeterContext,
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
    const caller = isGatewayClient(request);
    if (!caller) {
      return errorResponse(
        'Invalid API key. Use your Rev4a API key from the Gateway page via Authorization: Bearer <key>.',
        'authentication_error',
        401,
      );
    }

    const body: ProviderV1Request = await request.json();
    const { provider, model } = extractProviderAndModel(body);

    // The catalogue is policy, and policy has to be enforced where the money is
    // spent, not only where the pickers are drawn. Without this, unchecking a
    // model on the Gateway page hid it from every list and still served every
    // client that already held the id.
    if (!isModelOffered(provider, model)) {
      return errorResponse(
        `Model '${provider}/${model}' is not enabled for this deployment. ` +
        'Enable it on the Gateway page, or pick one that is.',
        'invalid_request_error',
        400,
      );
    }

    // Upstream credentials, distinct from the token that opened this door.
    const providerKeys = readProviderKeys();
    const apiKey = getApiKey(provider, providerKeys);
    if (!apiKey) {
      return errorResponse(
        `API key not configured for provider '${provider}'. Add it from the Gateway page.`,
        'configuration_error',
        401,
      );
    }

    // Token identities ignore the header and require a known agent. Legacy calls keep
    // their historical header resolution and hourly allowance for not-yet-known ids.
    const meter: MeterContext = {
      agent: resolveMeterAgent(caller.agentId, caller.kind === 'agent'),
      provider,
      model,
      startMs: start,
    };

    let upstreamResp: Response;
    try {
      upstreamResp = await callUpstream(provider, model, body, apiKey);
    } catch (e) {
      // The call was made and failed before any answer: it is still a call the proxy saw.
      recordProxyCall(meter, 0, null);
      throw e;
    }
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
      responseHeaders.set('x-rev4a-gateway', 'true');
      responseHeaders.set('x-rev4a-provider', provider);
      responseHeaders.set('x-rev4a-latency-ms', String(latency));
      return new Response(upstreamResp.body ? meterStream(upstreamResp.body, meter, upstreamResp.status) : null, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: responseHeaders,
      });
    }

    // Non-streaming: parse upstream JSON
    let responseText: string;
    try {
      responseText = await upstreamResp.text();
    } catch (e) {
      // The body broke off after the status: still a call the proxy saw, and a failed one.
      recordProxyCall(meter, 0, null);
      throw e;
    }
    meterBody(meter, upstreamResp.status, responseText);
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
    responseHeaders.set('x-rev4a-gateway', 'true');
    responseHeaders.set('x-rev4a-provider', provider);
    responseHeaders.set('x-rev4a-latency-ms', String(latency));

    return new Response(finalBodyStr, {
      status: upstreamResp.status,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    console.error('[provider/v1] The upstream request failed:', upstreamErrorDetails(err));
    return errorResponse('Gateway error: the upstream request failed', 'gateway_error', 502);
  }
}
