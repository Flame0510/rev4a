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
import { syncAllAgents } from '../sync';
import { detectProviderGatewayUrl } from '@/lib/docker-utils';
import { getPricing } from '@/lib/model-pricing';
import { loadModelsConfig, toggleModelOverride, type ModelConfigEntry } from '@/lib/model-catalogue';

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
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHeader: 'x-goog-api-key',
    docsUrl: 'https://aistudio.google.com/app/apikey',
  },
  deepseek: {
    envKey: 'PROVIDER_DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    authHeader: 'Authorization',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  openrouter: {
    envKey: 'PROVIDER_OPENROUTER_API_KEY',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    authHeader: 'Authorization',
    docsUrl: 'https://openrouter.ai/keys',
  },
  openai: {
    envKey: 'PROVIDER_OPENAI_API_KEY',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    authHeader: 'Authorization',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    envKey: 'PROVIDER_ANTHROPIC_API_KEY',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  groq: {
    envKey: 'PROVIDER_GROQ_API_KEY',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai',
    authHeader: 'Authorization',
    docsUrl: 'https://console.groq.com/keys',
  },
  kimi: {
    envKey: 'PROVIDER_KIMI_API_KEY',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn',
    authHeader: 'Authorization',
    docsUrl: 'https://platform.kimi.com/console/api-keys',
  },
  glm: {
    envKey: 'PROVIDER_GLM_API_KEY',
    label: 'GLM (Z.AI)',
    baseUrl: 'https://api.z.ai',
    authHeader: 'Authorization',
    docsUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  qwen: {
    envKey: 'PROVIDER_QWEN_API_KEY',
    label: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com',
    authHeader: 'Authorization',
    docsUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key',
  },
  rev4a: {
    envKey: 'REV4A_API_KEY',
    label: 'REV4A API KEY',
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

export async function GET() {
  const allModels = loadModelsConfig();
  const providerKeys = readProviderKeys();
  const providers = Object.entries(PROVIDER_CONFIGS).map(([key, cfg]) => {
    const providerModels = allModels.filter((m) => m.provider === key);
    return {
      provider: key, label: cfg.label, configured: !!providerKeys[key],
      baseUrl: cfg.baseUrl, docsUrl: cfg.docsUrl,
      models: providerModels.map((m) => {
        const entry: Record<string, unknown> = { id: m.id, name: m.name, enabled: m.enabled };
        const p = getPricing(m.id);
        if (p) entry.pricing = p;
        if (m.modality) entry.modality = m.modality;
        return entry;
      }),
      ...(providerKeys[key] ? { apiKey: providerKeys[key] } : {}),
    };
  });
  return NextResponse.json({ providers });
}

export async function POST(request: NextRequest) {
  try {
    const body: { provider?: string; apiKey?: string; _syncOnly?: boolean } = await request.json();

    if (body._syncOnly) {
      const syncResults = syncAllAgents();
      return NextResponse.json({ status: 'ok', sync: syncResults });
    }

    const providerName = body.provider;
    if (!providerName || !PROVIDER_CONFIGS[providerName]) {
      return NextResponse.json({ status: 'error', error: `Unknown provider: ${providerName}. Known: ${Object.keys(PROVIDER_CONFIGS).join(', ')}` }, { status: 400 });
    }
    const apiKeyValue = body.apiKey;
    const isRemove = !apiKeyValue || apiKeyValue.trim() === '';
    setProviderApiKey(providerName, isRemove ? null : apiKeyValue!.trim());
    let syncResults: string[] = [];
    try {
      syncResults = syncAllAgents();
    } catch (se) {
      syncResults = [`Sync error: ${se instanceof Error ? se.message : String(se)}`];
    }
    return NextResponse.json({
      status: 'ok', provider: providerName, configured: !isRemove,
      sync: syncResults,
    });
  } catch (e: unknown) {
    return NextResponse.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body: { modelId?: string; enabled?: boolean } = await request.json();
    const { modelId, enabled } = body;
    if (!modelId) return NextResponse.json({ status: 'error', error: 'modelId is required' }, { status: 400 });
    if (typeof enabled !== 'boolean') return NextResponse.json({ status: 'error', error: 'enabled (boolean) is required' }, { status: 400 });

    const models = loadModelsConfig();
    const idx = models.findIndex((m) => m.id === modelId);
    if (idx === -1) return NextResponse.json({ status: 'error', error: `Model not found: ${modelId}` }, { status: 404 });

    toggleModelOverride(modelId, enabled);
    const syncResults = syncAllAgents();
    return NextResponse.json({ status: 'ok', modelId, enabled, provider: models[idx].provider, sync: syncResults });
  } catch (e: unknown) {
    return NextResponse.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
