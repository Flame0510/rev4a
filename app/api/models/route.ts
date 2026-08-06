import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';
import { MODELS_CONFIG_FILE } from '@/lib/rev4a-paths';
import * as fs from 'fs';
import * as path from 'path';
import { readProviderKeys } from '@/app/api/gateway/provider/keys';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

interface ModelsConfigEntry {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
}

const CONFIG_PATH = MODELS_CONFIG_FILE;

const PROVIDER_EMOJI: Record<string, string> = {
  deepseek: '🧠',
  openrouter: '🌐',
  groq: '⚡',
  openai: '🤖',
  'openai-codex': '🤖',
  anthropic: '🟣',
  rev4a: '🔴',
};

const PROVIDER_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  anthropic: 'Anthropic',
  rev4a: 'Rev4a',
};

function loadModelsConfig(): ModelsConfigEntry[] {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.models)) return parsed.models as ModelsConfigEntry[];
  } catch {}
  return [];
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const request = _req;
  const allModels = loadModelsConfig();
  const providerKeys = readProviderKeys();
  const configured = new Set(Object.keys(providerKeys));

  const eligible = allModels.filter((m) => {
    if (!m.enabled) return false;
    if (configured.has(m.provider)) return true;
    // rev4a/* aliases resolve to deepseek upstream
    if (m.provider === 'rev4a' && configured.has('deepseek')) return true;
    return false;
  });

  const grouped = new Map<string, { provider: string; emoji: string; models: { id: string; label: string }[] }>();

  for (const model of eligible) {
    if (!grouped.has(model.provider)) {
      grouped.set(model.provider, {
        provider: PROVIDER_LABEL[model.provider] || model.provider,
        emoji: PROVIDER_EMOJI[model.provider] || '🔌',
        models: [],
      });
    }
    grouped.get(model.provider)!.models.push({ id: model.id, label: model.name });
  }

  return NextResponse.json(Array.from(grouped.values()));
}
