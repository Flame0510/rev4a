/**
 * Model pricing data — static, from model-pricing.json in the project root.
 *
 * OpenRouter models are NOT included here; their pricing is fetched live
 * via the OpenRouter API and merged client-side.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ModelPricing {
  input: number;
  output: number;
}

let _cache: Record<string, ModelPricing> | null = null;
let _cacheMtime = 0;

function resolvePricingPath(): string {
  // Try cwd first (works with systemd WorkingDirectory)
  const cwdPath = path.resolve(process.cwd(), 'model-pricing.json');
  if (fs.existsSync(cwdPath)) return cwdPath;
  // Fallback: relative to this module (works for npm global installs)
  return path.resolve(__dirname, '..', 'model-pricing.json');
}

const PRICING_PATH = resolvePricingPath();

function load(): Record<string, ModelPricing> {
  try {
    const stat = fs.statSync(PRICING_PATH);
    if (_cache && stat.mtimeMs <= _cacheMtime) return _cache;
    const raw = fs.readFileSync(PRICING_PATH, 'utf-8');
    _cache = JSON.parse(raw) as Record<string, ModelPricing>;
    _cacheMtime = stat.mtimeMs;
    return _cache!;
  } catch {
    return {};
  }
}

/** Get pricing for a single model, or null if not found. */
export function getPricing(modelId: string): ModelPricing | null {
  const all = load();
  return all[modelId] ?? null;
}

/** Get all static pricing entries. */
export function getAllPricing(): Record<string, ModelPricing> {
  return { ...load() };
}

/** Format pricing for display: "$0.44 / $0.87" or "Free" or "Dynamic" or "—" */
export function formatPricing(p: ModelPricing | null | undefined): string {
  if (!p) return '—';
  if (p.input === -1 && p.output === -1) return 'Dynamic';
  if (p.input === 0 && p.output === 0) return 'Free';
  const fmt = (n: number) => {
    if (n < 0.01) return `$${n.toFixed(3)}`;
    if (n < 1) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(2)}`;
  };
  return `${fmt(p.input)} / ${fmt(p.output)}`;
}
