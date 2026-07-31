/**
 * Gateway Provider API
 *
 * GET  /api/gateway/provider   — list providers and their model config
 * POST /api/gateway/provider   — set/remove API key + sync models + sync agent
 * PUT  /api/gateway/provider   — toggle individual model on/off + sync
 */
import { NextRequest, NextResponse } from 'next/server';
import { MODELS_CONFIG_FILE } from '@/lib/olympus-paths';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { readProviderKeys, writeProviderKeys } from './keys';
import { syncAllAgents } from '../sync';
import { detectProviderGatewayUrl } from '@/lib/docker-utils';
import { getPricing } from '@/lib/model-pricing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */
interface ModelConfigEntry {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
}

interface ProviderEnvConfig {
  envKey: string;
  label: string;
  baseUrl: string;
  authHeader: string;
  docsUrl: string;
}

const MODELS_CONFIG_PATH = MODELS_CONFIG_FILE;

const PROVIDER_CONFIGS: Record<string, ProviderEnvConfig> = {
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
  olympus: {
    envKey: 'OLYMPUS_API_KEY',
    label: 'OLYMPUS API KEY',
    baseUrl: detectProviderGatewayUrl(),
    authHeader: 'Authorization',
    docsUrl: '',
  },
};

const DEFAULT_CATALOGUE: ModelConfigEntry[] = [
  // OpenAI
  { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai', enabled: true },
  { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'openai', enabled: true },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai', enabled: true },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5', provider: 'openai', enabled: true },
  { id: 'openai/gpt-5.4', name: 'GPT-5.4', provider: 'openai', enabled: true },
  { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai', enabled: true },
  // Anthropic
  { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5', provider: 'anthropic', enabled: false },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic', enabled: false },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic', enabled: false },
  { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', enabled: false },
  // DeepSeek
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', enabled: true },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', enabled: true },
  // OpenRouter
  { id: 'openrouter/auto', name: 'OpenRouter Auto', provider: 'openrouter', enabled: true },
  { id: 'openrouter/deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash (OR)', provider: 'openrouter', enabled: true },
  { id: 'openrouter/google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (OR)', provider: 'openrouter', enabled: true },
  { id: 'openrouter/google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (OR)', provider: 'openrouter', enabled: true },
  { id: 'openrouter/anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (OR)', provider: 'openrouter', enabled: false },
  { id: 'openrouter/deepseek/deepseek-r1-0528', name: 'DeepSeek R1 0528 (OR)', provider: 'openrouter', enabled: false },
  // Groq
  { id: 'groq/llama-3.1-8b-instant', name: 'Llama 3.1 8B (Groq)', provider: 'groq', enabled: false },
  { id: 'groq/llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq)', provider: 'groq', enabled: false },
  // Kimi
  { id: 'kimi/kimi-k3', name: 'Kimi K3', provider: 'kimi', enabled: true },
  { id: 'kimi/kimi-k2.7-code', name: 'Kimi K2.7 Code', provider: 'kimi', enabled: false },
  { id: 'kimi/kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code HighSpeed', provider: 'kimi', enabled: false },
  { id: 'kimi/kimi-k2.6', name: 'Kimi K2.6', provider: 'kimi', enabled: false },
  // GLM
  { id: 'glm/glm-5.2', name: 'GLM-5.2', provider: 'glm', enabled: false },
  { id: 'glm/glm-5.1', name: 'GLM-5.1', provider: 'glm', enabled: false },
  { id: 'glm/glm-5', name: 'GLM-5', provider: 'glm', enabled: false },
  { id: 'glm/glm-4.7', name: 'GLM-4.7', provider: 'glm', enabled: false },
  { id: 'glm/glm-4.7-flash', name: 'GLM-4.7 Flash', provider: 'glm', enabled: false },
  { id: 'glm/glm-4.7-flashx', name: 'GLM-4.7 FlashX', provider: 'glm', enabled: false },
  { id: 'glm/glm-5v-turbo', name: 'GLM-5V Turbo', provider: 'glm', enabled: false },
  { id: 'glm/glm-4.6v-flash', name: 'GLM-4.6V Flash', provider: 'glm', enabled: false },
  // Qwen
  { id: 'qwen/qwen3.7-max', name: 'Qwen 3.7 Max', provider: 'qwen', enabled: false },
  { id: 'qwen/qwen3.7-plus', name: 'Qwen 3.7 Plus', provider: 'qwen', enabled: true },
  { id: 'qwen/qwen3.7-flash', name: 'Qwen 3.7 Flash', provider: 'qwen', enabled: false },
  { id: 'qwen/qwen3-coder-plus', name: 'Qwen 3 Coder Plus', provider: 'qwen', enabled: false },
  { id: 'qwen/qwen-long', name: 'Qwen Long', provider: 'qwen', enabled: false },

];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function loadModelsConfig(): ModelConfigEntry[] {
  try {
    const raw = fs.readFileSync(MODELS_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.models)) return parsed.models as ModelConfigEntry[];
  } catch { /* fall through */ }
  try {
    fs.writeFileSync(MODELS_CONFIG_PATH, JSON.stringify({ models: DEFAULT_CATALOGUE }, null, 2), 'utf-8');
  } catch { /* ignore */ }
  return DEFAULT_CATALOGUE;
}

function writeModelsConfig(models: ModelConfigEntry[]): void {
  fs.writeFileSync(MODELS_CONFIG_PATH, JSON.stringify({ models }, null, 2), 'utf-8');
}

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
    const stdout = execSync('sudo systemctl restart olympus.target 2>&1', { timeout: 15000, maxBuffer: 64 * 1024 }).toString();
    return { stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || err.message || 'Unknown error' };
  }
}

/* ------------------------------------------------------------------ */
/*  Agent sync — update openclaw.json in agent containers             */
/* ------------------------------------------------------------------ */

// Agent sync moved to ../sync.ts — imported as syncAllAgents

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

    // Allow sync-only requests (no provider change needed)
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
    models[idx].enabled = enabled;
    writeModelsConfig(models);
    const syncResults = syncAllAgents();
    return NextResponse.json({ status: 'ok', modelId, enabled, provider: models[idx].provider, sync: syncResults });
  } catch (e: unknown) {
    return NextResponse.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
