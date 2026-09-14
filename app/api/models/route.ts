import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';
import { readProviderKeys } from '@/app/api/gateway/provider/keys';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { loadOfferedModels } from '@/lib/model-catalogue';
import { getPricing } from '@/lib/model-pricing';

export const dynamic = 'force-dynamic';

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

/**
 * Model picker source. Uses the shared catalogue loader so the list offered here
 * matches what the sync actually writes into agent containers — this route used
 * to read models.config.json directly and ignore model-overrides.json, so models
 * switched off on the Gateway page still showed up as selectable.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const request = _req;
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  const eligible = loadOfferedModels();

  const grouped = new Map<string, {
    provider: string;
    emoji: string;
    models: {
      id: string; label: string;
      input: number | null; output: number | null;
      deprecated: boolean;
    }[];
  }>();

  for (const model of eligible) {
    if (!grouped.has(model.provider)) {
      grouped.set(model.provider, {
        provider: PROVIDER_LABEL[model.provider] || model.provider,
        emoji: PROVIDER_EMOJI[model.provider] || '🔌',
        models: [],
      });
    }
    // Price travels with the option so the picker can show cost at the point of
    // choice, instead of sending the operator to another page to look it up.
    const price = getPricing(model.id);
    grouped.get(model.provider)!.models.push({
      id: model.id,
      label: model.name,
      input: price?.input ?? null,
      output: price?.output ?? null,
      deprecated: model.deprecated ?? false,
    });
  }

  return NextResponse.json(Array.from(grouped.values()));
}
