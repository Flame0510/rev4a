/**
 * Gateway Provider API
 *
 * GET  /api/gateway/provider   — list providers and their model config
 * POST /api/gateway/provider   — set/remove API key + sync models + sync agent
 * PUT  /api/gateway/provider   — toggle individual model on/off + sync
 */
import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readProviderKeys, writeProviderKeys } from './keys';
import { dockerUnreachableReason, syncAllAgents, type SyncOutcome } from '../sync';
import { detectProviderGatewayUrl } from '@/lib/docker-utils';
import { getPricing, nextPriceChange, priceAt, priceBandAt } from '@/lib/model-pricing';
import { getModelParams } from '@/lib/model-details';
import { PROVIDER_LABELS } from '@/lib/provider-labels';
import { loadModelsConfig, toggleModelOverride, type ModelConfigEntry } from '@/lib/model-catalogue';
import { getLivePricing } from '@/lib/openrouter-pricing';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface ProviderEnvConfig {
  envKey: string;
  label: string;
  baseUrl: string;
  authHeader: string;
  docsUrl: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderEnvConfig> = {
  google: {
    envKey: 'PROVIDER_GOOGLE_API_KEY',
    label: PROVIDER_LABELS.google,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHeader: 'x-goog-api-key',
    docsUrl: 'https://aistudio.google.com/app/apikey',
  },
  deepseek: {
    envKey: 'PROVIDER_DEEPSEEK_API_KEY',
    label: PROVIDER_LABELS.deepseek,
    baseUrl: 'https://api.deepseek.com',
    authHeader: 'Authorization',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  openrouter: {
    envKey: 'PROVIDER_OPENROUTER_API_KEY',
    label: PROVIDER_LABELS.openrouter,
    baseUrl: 'https://openrouter.ai/api',
    authHeader: 'Authorization',
    docsUrl: 'https://openrouter.ai/keys',
  },
  openai: {
    envKey: 'PROVIDER_OPENAI_API_KEY',
    label: PROVIDER_LABELS.openai,
    baseUrl: 'https://api.openai.com',
    authHeader: 'Authorization',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    envKey: 'PROVIDER_ANTHROPIC_API_KEY',
    label: PROVIDER_LABELS.anthropic,
    baseUrl: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  groq: {
    envKey: 'PROVIDER_GROQ_API_KEY',
    label: PROVIDER_LABELS.groq,
    baseUrl: 'https://api.groq.com/openai',
    authHeader: 'Authorization',
    docsUrl: 'https://console.groq.com/keys',
  },
  kimi: {
    envKey: 'PROVIDER_KIMI_API_KEY',
    label: PROVIDER_LABELS.kimi,
    baseUrl: 'https://api.moonshot.cn',
    authHeader: 'Authorization',
    docsUrl: 'https://platform.kimi.com/console/api-keys',
  },
  glm: {
    envKey: 'PROVIDER_GLM_API_KEY',
    label: PROVIDER_LABELS.glm,
    baseUrl: 'https://api.z.ai',
    authHeader: 'Authorization',
    docsUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  qwen: {
    envKey: 'PROVIDER_QWEN_API_KEY',
    label: PROVIDER_LABELS.qwen,
    baseUrl: 'https://dashscope.aliyuncs.com',
    authHeader: 'Authorization',
    docsUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key',
  },
  rev4a: {
    envKey: 'REV4A_API_KEY',
    label: PROVIDER_LABELS.rev4a,
    baseUrl: detectProviderGatewayUrl(),
    authHeader: 'Authorization',
    docsUrl: '',
  },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getProviderApiKey(providerName: string): string | null {
  const keys = readProviderKeys();
  return keys[providerName] || null;
}

function setProviderApiKey(providerName: string, value: string | null): void {
  const keys = readProviderKeys();
  if (value === null) {
    delete keys[providerName];
  } else {
    keys[providerName] = value;
  }
  writeProviderKeys(keys);
}

function restartService(): { stdout: string; stderr: string } {
  try {
    const stdout = execSync('sudo systemctl restart rev4a.service 2>&1', { timeout: 15000, maxBuffer: 64 * 1024 }).toString();
    return { stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || err.message || 'Unknown error' };
  }
}

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

export async function GET(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  const providerKeys = readProviderKeys();

  // ?summary=1 — just "which providers have a key", no models, no pricing.
  // The full response awaits live pricing from OpenRouter, a network round trip
  // that costs ~2.4s cold. Callers that only need the boolean (the agents page,
  // to decide whether to warn about a missing provider) must not pay for it, and
  // must not be left guessing while it's in flight.
  if (request.nextUrl.searchParams.get('summary') === '1') {
    return NextResponse.json({
      providers: Object.entries(PROVIDER_CONFIGS).map(([key, cfg]) => ({
        provider: key,
        label: cfg.label,
        configured: !!providerKeys[key],
      })),
    });
  }

  const allModels = loadModelsConfig();

  // Live prices overlaid on the static file, which drifts. Fetched regardless
  // of whether OpenRouter is configured: the catalogue is public, and prices
  // are most useful precisely to someone still deciding whether to enable it.
  // Best-effort — an empty map means the static values stand in.
  //
  // Modality deliberately stays on the curated value: sync.ts provisions
  // containers from it, so taking a different one upstream would advertise
  // inputs the agent was never configured to accept.
  const livePricing = await getLivePricing(allModels.map((m) => m.id));
  // Sizes for the row's "next to the price" hint: open-weight models only (see
  // docs/dev/GATEWAY.md), absent for a model whose vendor does not publish one.
  const paramsByModel = getModelParams();
  const pricingAt = new Date();

  const providers = Object.entries(PROVIDER_CONFIGS).map(([key, cfg]) => {
    const providerModels = allModels.filter((m) => m.provider === key);
    return {
      provider: key, label: cfg.label, configured: !!providerKeys[key],
      baseUrl: cfg.baseUrl, docsUrl: cfg.docsUrl,
      models: providerModels.map((m) => {
        const entry: Record<string, unknown> = { id: m.id, name: m.name, enabled: m.enabled };
        const livePrice = livePricing.get(m.id);
        if (livePrice) {
          entry.pricing = livePrice;
          entry.pricingLive = true;
        } else {
          const staticPrice = getPricing(m.id);
          if (staticPrice) entry.pricing = staticPrice;
        }
        if (m.modality) entry.modality = m.modality;
        if (paramsByModel[m.id]) entry.params = paramsByModel[m.id];
        // The band billed right now for a time-of-day vendor (DeepSeek peak / off-peak):
        // null for every model priced the same all day. The synced agent prices follow it
        // (lib/price-schedule-sync.ts); the row shows the same thing — including the price,
        // which is the rate in force now, not the peak list price.
        const band = priceBandAt(m.id, pricingAt);
        if (band) {
          entry.band = band;
          // The live OpenRouter overlay outranks the static band arithmetic (disjoint
          // today — only `deepseek` is scheduled, only `openrouter/*` is live-priced —
          // but keep it explicit so a future schedule never silent-replaces live prices).
          if (!entry.pricingLive) {
            const now = priceAt(m.id, pricingAt);
            if (now) entry.pricing = now;
          }
        }
        return entry;
      }),
      ...(providerKeys[key] ? { apiKey: providerKeys[key] } : {}),
    };
  });
  // When the band flips next, so an open page can refresh the chips right after it.
  const nextChange = nextPriceChange(allModels.map((m) => m.id), pricingAt);
  return NextResponse.json({ providers, nextPriceChangeMs: nextChange ? nextChange.getTime() : null });
}

/**
 * Run the sync without letting an unexpected throw turn a committed change into a
 * 500. `syncAllAgents` already reports Docker and per-container failures as data;
 * this only guards the rest.
 */
function runSync(): SyncOutcome {
  try {
    return syncAllAgents();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, activeModels: 0, total: 0, synced: [], stopped: [], failed: [], configError: msg, summary: `Not applied to any agent: ${msg}.` };
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  try {
    const body: { provider?: string; apiKey?: string; _syncOnly?: boolean } = await request.json();

    if (body._syncOnly) {
      // Here the sync *is* the operation, so its outcome is the status.
      const sync = runSync();
      return NextResponse.json(
        sync.ok ? { status: 'ok', sync } : { status: 'error', error: sync.summary, sync },
        { status: sync.ok ? 200 : 502 },
      );
    }

    const providerName = body.provider;
    if (!providerName || !PROVIDER_CONFIGS[providerName]) {
      return NextResponse.json({ status: 'error', error: `Unknown provider: ${providerName}. Known: ${Object.keys(PROVIDER_CONFIGS).join(', ')}` }, { status: 400 });
    }
    const apiKeyValue = body.apiKey;
    const isRemove = !apiKeyValue || apiKeyValue.trim() === '';
    setProviderApiKey(providerName, isRemove ? null : apiKeyValue!.trim());
    // The key is saved whatever the sync does next; report the two separately.
    const sync = runSync();
    return NextResponse.json({
      status: 'ok', provider: providerName, configured: !isRemove,
      sync,
    });
  } catch (e: unknown) {
    return NextResponse.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  try {
    const body: { modelId?: string; enabled?: boolean } = await request.json();
    const { modelId, enabled } = body;
    if (!modelId) return NextResponse.json({ status: 'error', error: 'modelId is required' }, { status: 400 });
    if (typeof enabled !== 'boolean') return NextResponse.json({ status: 'error', error: 'enabled (boolean) is required' }, { status: 400 });

    const models = loadModelsConfig();
    const idx = models.findIndex((m) => m.id === modelId);
    if (idx === -1) return NextResponse.json({ status: 'error', error: `Model not found: ${modelId}` }, { status: 404 });

    // Refuse up front when the sync cannot happen at all. Saving anyway would leave
    // the checkbox on /gateway saying one thing and every agent holding another.
    // Only a whole-fleet outage is refused this way: once Docker answers, a container
    // that fails individually is reported in `sync`, because undoing the override
    // would not undo the containers that did receive it. Provider key saves are not
    // gated like this — the first-run wizard saves keys without reading the response
    // and may run before Docker is up, so a refusal there would be silent.
    const unreachable = dockerUnreachableReason();
    if (unreachable) {
      return NextResponse.json({
        status: 'error',
        error: `Not changed: Docker is unreachable (${unreachable}). Nothing was saved, so the Gateway still matches the agents.`,
      }, { status: 503 });
    }

    toggleModelOverride(modelId, enabled);
    // `status` is the toggle, committed at this point. `sync` is whether the fleet
    // got it — reported alongside, not folded into `status`.
    const sync = runSync();
    return NextResponse.json({ status: 'ok', modelId, enabled, provider: models[idx].provider, sync });
  } catch (e: unknown) {
    return NextResponse.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
