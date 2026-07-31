/**
 * Provider Balance — fetch account balance/credits from upstream AI providers.
 *
 * Each provider has its own non-standard endpoint and response format.
 * We normalize them all to a common {balance, currency, raw} shape.
 *
 * Currently supported: deepseek, openrouter, glm (Z.AI)
 * Not supported via API key: openai (needs cookie), anthropic, groq, qwen
 */
import { readProviderKeys } from '@/app/api/gateway/provider/keys';

export interface BalanceResult {
  /** Human-readable balance string, e.g. "$23.45" or "¥156.00" */
  balance: string;
  /** ISO currency code */
  currency: string;
  /** Raw value as number */
  value: number;
  /** Provider-specific extra info (optional) */
  label?: string;
}

interface BalanceInfo {
  currency: string;
  total_balance: string;
  topped_up_balance?: string;
  granted_balance?: string;
}

/* ------------------------------------------------------------------ */
/*  DeepSeek                                                            */
/* ------------------------------------------------------------------ */

async function fetchDeepSeekBalance(apiKey: string): Promise<BalanceResult> {
  const resp = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`DeepSeek balance API returned ${resp.status}`);
  }
  const json = await resp.json() as {
    is_available: boolean;
    balance_infos: BalanceInfo[];
  };

  const infos = json.balance_infos ?? [];
  // Prefer CNY if available, else first entry
  const cny = infos.find((i) => i.currency === 'CNY') ?? infos[0];
  if (!cny) throw new Error('DeepSeek returned no balance info');

  const value = parseFloat(cny.total_balance);
  const currency = cny.currency;
  const balance = `${currency === 'CNY' ? '¥' : '$'}${value.toFixed(2)}`;
  return { balance, currency, value, label: 'Total balance' };
}

/* ------------------------------------------------------------------ */
/*  OpenRouter                                                          */
/* ------------------------------------------------------------------ */

interface OpenRouterCredits {
  data: {
    credits: number;
    total_spent: number;
    total_used: number;
  };
}

async function fetchOpenRouterBalance(apiKey: string): Promise<BalanceResult> {
  const resp = await fetch('https://openrouter.ai/api/v1/credits', {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`OpenRouter credits API returned ${resp.status}`);
  }
  const json = (await resp.json()) as OpenRouterCredits;
  const value = json.data.credits;
  return { balance: `$${value.toFixed(2)}`, currency: 'USD', value, label: 'Credits' };
}

/* ------------------------------------------------------------------ */
/*  Z.AI / GLM                                                          */
/* ------------------------------------------------------------------ */

interface ZAILimit {
  /** e.g. "TOKENS_LIMIT" */
  limitType: string;
  limitValue: number;
  /** remaining tokens */
  remaining: number;
  usage: number;
  percentage: number;
  nextResetTime?: string;
}

async function fetchZAIBalance(apiKey: string): Promise<BalanceResult> {
  const resp = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Z.AI quota API returned ${resp.status}`);
  }
  const json = await resp.json() as { limits?: ZAILimit[] };

  const tokenLimit = json.limits?.find((l) => l.limitType === 'TOKENS_LIMIT');
  if (tokenLimit) {
    const usage = tokenLimit.usage ?? 0;
    const limit = tokenLimit.limitValue ?? 0;
    const remaining = tokenLimit.remaining ?? limit - usage;
    const value = remaining;
    // Show remaining + percentage
    return {
      balance: `${(remaining / 1_000_000).toFixed(1)}M tokens`,
      currency: 'TOKENS',
      value,
      label: `${tokenLimit.percentage?.toFixed(0) ?? 0}% used of ${(limit / 1_000_000).toFixed(1)}M`,
    };
  }

  // Fallback: sum all limits
  const totalRemaining = (json.limits ?? []).reduce(
    (sum, l) => sum + (l.remaining ?? l.limitValue - l.usage),
    0,
  );
  return {
    balance: `${(totalRemaining / 1_000_000).toFixed(1)}M tokens`,
    currency: 'TOKENS',
    value: totalRemaining,
    label: 'Remaining',
  };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

export type BalanceProvider = 'deepseek' | 'openrouter' | 'glm';

const BALANCE_FETCHERS: Record<
  BalanceProvider,
  (apiKey: string) => Promise<BalanceResult>
> = {
  deepseek: fetchDeepSeekBalance,
  openrouter: fetchOpenRouterBalance,
  glm: fetchZAIBalance,
};

/** Fetch balance for a single provider. Throws if not supported or API key missing. */
export async function fetchProviderBalance(
  provider: BalanceProvider,
): Promise<BalanceResult> {
  const keys = readProviderKeys();
  const apiKey = keys[provider];
  if (!apiKey) {
    throw new Error(`No API key configured for ${provider}`);
  }

  const fetcher = BALANCE_FETCHERS[provider];
  if (!fetcher) {
    throw new Error(`Balance fetching not supported for ${provider}`);
  }

  return fetcher(apiKey);
}
