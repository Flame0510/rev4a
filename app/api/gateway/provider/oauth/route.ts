/**
 * Gateway OAuth — Device Code Flow
 *
 * POST /api/gateway/provider/oauth           — start device code flow
 * GET  /api/gateway/provider/oauth           — poll authorization status
 * POST /api/gateway/provider/oauth/save      — save completed token
 *
 * Designed for multiple providers (openai-codex, github-copilot, claude-cli, etc.)
 * Each provider defines its own device code config + token exchange logic.
 *
 * After successful auth, the API key is saved to provider-keys.json
 * and the provider appears automatically in /api/models and Pythia.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readProviderKeys, writeProviderKeys } from '@/app/api/gateway/provider/keys';

export const dynamic = 'force-dynamic';

// ── Provider OAuth configs ─────────────────────────────────────────────

interface DeviceCodeConfig {
  clientId: string;
  clientSecret?: string;
  deviceCodeUrl: string;
  pollUrl: string;
  tokenUrl: string;
  verificationUrl: string;
  verificationTitle?: string;
  defaultIntervalMs: number;
  /** How to authenticate in the token exchange */
  authStyle: 'basic' | 'json' | 'form';
  /** Extra headers to send */
  extraHeaders?: Record<string, string>;
  /** Custom token exchange logic — returns { accessToken, refreshToken?, expiresMs? } */
  exchangeTokens?: (data: Record<string, unknown>, config: DeviceCodeConfig) => Promise<OAuthTokenResult>;
  /** Display-friendly name */
  label: string;
}

interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresMs?: number;
}

const OAUTH_CONFIGS: Record<string, DeviceCodeConfig> = {
  'openai-codex': {
    label: 'OpenAI Codex',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    deviceCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    pollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    verificationUrl: 'https://auth.openai.com/codex/device',
    verificationTitle: 'auth.openai.com',
    defaultIntervalMs: 5000,
    authStyle: 'json',
    extraHeaders: {
      originator: 'openclaw',
      'User-Agent': 'openclaw/olympus',
    },
  },

  'github-copilot': {
    label: 'GitHub Copilot',
    clientId: 'Iv23lirMpKoFUugB9w4p',
    deviceCodeUrl: 'https://github.com/login/device/code',
    pollUrl: 'https://github.com/login/oauth/access_token',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    verificationUrl: 'https://github.com/login/device',
    verificationTitle: 'github.com',
    defaultIntervalMs: 5000,
    authStyle: 'json',
  },

  // Placeholder for future providers:
  // 'claude-cli': {
  //   label: 'Claude CLI',
  //   clientId: '...',
  //   ...
  // },
};

// ── START device code flow ─────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => ({}));
    const provider = body.provider as string | undefined;

    if (!provider || !OAUTH_CONFIGS[provider]) {
      const available = Object.keys(OAUTH_CONFIGS);
      return NextResponse.json({
        error: `Unknown or unsupported provider: '${provider}'`,
        available,
      }, { status: 400 });
    }

    const config = OAUTH_CONFIGS[provider];

    // Step 1: request device code
    const deviceRes = await fetch(config.deviceCodeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.extraHeaders,
      },
      body: JSON.stringify({ client_id: config.clientId }),
    });

    if (!deviceRes.ok) {
      const errText = await deviceRes.text();
      return NextResponse.json({
        status: 'failed',
        error: `Device code request failed: HTTP ${deviceRes.status} — ${errText.slice(0, 300)}`,
      }, { status: 502 });
    }

    const deviceData = await deviceRes.json() as Record<string, unknown>;
    const deviceAuthId = (deviceData.device_auth_id || deviceData.device_code) as string | undefined;
    const userCode = (deviceData.user_code || deviceData.usercode) as string | undefined;

    if (!deviceAuthId || !userCode) {
      return NextResponse.json({
        status: 'failed',
        error: 'Provider response missing device_auth_id or user_code',
        raw: deviceData,
      }, { status: 502 });
    }

    const intervalMs = typeof deviceData.interval === 'number'
      ? deviceData.interval * 1000
      : config.defaultIntervalMs;

    return NextResponse.json({
      status: 'pending',
      provider,
      label: config.label,
      deviceAuthId,
      userCode,
      verificationUri: config.verificationUrl,
      verificationTitle: config.verificationTitle || new URL(config.verificationUrl).hostname,
      intervalMs,
      expiresMs: Date.now() + 15 * 60 * 1000, // 15 min timeout
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: 'failed', error: message }, { status: 500 });
  }
}

// ── POLL authorization status ──────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const provider = request.nextUrl.searchParams.get('provider');
    const deviceAuthId = request.nextUrl.searchParams.get('deviceAuthId');
    const userCode = request.nextUrl.searchParams.get('userCode') || '';
    const expiresMs = parseInt(request.nextUrl.searchParams.get('expiresMs') || '0');

    if (!provider || !deviceAuthId) {
      return NextResponse.json({ status: 'missing_params', error: 'provider and deviceAuthId required' }, { status: 400 });
    }

    // Check timeout
    if (expiresMs && Date.now() > expiresMs) {
      return NextResponse.json({ status: 'timeout', message: 'Authorization timed out. Please start again.' });
    }

    const config = OAUTH_CONFIGS[provider];
    if (!config) {
      return NextResponse.json({ status: 'unsupported', error: `Unknown provider: ${provider}` }, { status: 400 });
    }

    // Poll
    const pollHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.extraHeaders,
    };

    const pollBody: Record<string, string> = {
      device_auth_id: deviceAuthId,
      user_code: userCode,
    };

    if (config.authStyle === 'json') {
      pollBody.client_id = config.clientId;
    }

    const pollRes = await fetch(config.pollUrl, {
      method: 'POST',
      headers: pollHeaders,
      body: JSON.stringify(pollBody),
    });

    // Authorization still pending — provider returns 403/40x
    if (!pollRes.ok) {
      if (pollRes.status === 403 || pollRes.status === 404) {
        return NextResponse.json({ status: 'pending' });
      }

      const errText = await pollRes.text();
      try {
        const err = JSON.parse(errText);
        if (err.error === 'authorization_pending') {
          return NextResponse.json({ status: 'pending' });
        }
        if (err.error === 'slow_down') {
          return NextResponse.json({ status: 'pending', delayMs: 10000 });
        }
      } catch {
        // not JSON, fall through
      }

      return NextResponse.json({
        status: 'failed',
        error: `Poll failed: HTTP ${pollRes.status} — ${errText.slice(0, 300)}`,
      }, { status: 502 });
    }

    // Success! Parse tokens
    const data = await pollRes.json() as Record<string, unknown>;

    // OpenAI Codex: returns authorization_code + code_verifier, needs exchange
    if (provider === 'openai-codex' && data.authorization_code && data.code_verifier) {
      const exchangeBody = new URLSearchParams();
      exchangeBody.append('grant_type', 'authorization_code');
      exchangeBody.append('code', data.authorization_code as string);
      exchangeBody.append('redirect_uri', 'https://auth.openai.com/deviceauth/callback');
      exchangeBody.append('client_id', config.clientId);
      exchangeBody.append('code_verifier', data.code_verifier as string);

      const exchangeHeaders: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...config.extraHeaders,
      };

      const exchangeRes = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: exchangeHeaders,
        body: exchangeBody,
      });

      if (!exchangeRes.ok) {
        const errText = await exchangeRes.text();
        return NextResponse.json({
          status: 'failed',
          error: `Token exchange failed: HTTP ${exchangeRes.status} — ${errText.slice(0, 300)}`,
        }, { status: 502 });
      }

      const tokenData = await exchangeRes.json() as Record<string, unknown>;
      const accessToken = tokenData.access_token as string;
      const refreshToken = tokenData.refresh_token as string;

      if (!accessToken) {
        return NextResponse.json({ status: 'failed', error: 'No access_token in exchange response' }, { status: 502 });
      }

      // Save to provider-keys.json
      const keys = readProviderKeys();
      keys[provider] = accessToken;
      writeProviderKeys(keys);

      const expiresIn = tokenData.expires_in as number | undefined;

      return NextResponse.json({
        status: 'completed',
        provider,
        label: config.label,
        refreshToken: refreshToken || null,
        expiresMs: expiresIn ? Date.now() + expiresIn * 1000 : null,
      });
    }

    // Direct access_token providers (github-copilot, etc.)
    if (data.access_token) {
      const accessToken = data.access_token as string;

      // Save to provider-keys.json
      const keys = readProviderKeys();
      keys[provider] = accessToken;
      writeProviderKeys(keys);

      const expiresIn = data.expires_in as number | undefined;

      return NextResponse.json({
        status: 'completed',
        provider,
        label: config.label,
        refreshToken: (data.refresh_token as string) || null,
        expiresMs: expiresIn ? Date.now() + expiresIn * 1000 : null,
      });
    }

    // Still waiting
    return NextResponse.json({ status: 'pending' });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: 'failed', error: message }, { status: 500 });
  }
}
