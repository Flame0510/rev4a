/**
 * Model details for the details modal: the curated catalogue entry
 * (`models.config.json`), its price (`model-pricing.json`) and the generated specs,
 * description and benchmarks (`model-details.json`, written by
 * `scripts/refresh-model-pricing.mjs` from the OpenRouter catalogue).
 *
 * The generated file is optional on purpose: a checkout that never ran the script has
 * fewer fields, never an error. Prices for direct providers come from their own price list
 * (the script is scoped to `openrouter/*`), so the view labels where each number is from.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadModelsConfig, type ModelInfo } from '@/lib/model-catalogue';
import { providerLabel } from '@/lib/provider-labels';
import { getPricing } from '@/lib/model-pricing';

/** What `scripts/refresh-model-pricing.mjs` writes per id. All optional. */
export interface GeneratedDetails {
  description?: string;
  /** Release/listing date, `YYYY-MM-DD`. */
  created?: string;
  context?: number;
  /** The provider's own context limit, when OpenRouter reports a different one. */
  providerContext?: number;
  maxOutput?: number;
  tokenizer?: string;
  instructType?: string;
  /** Total parameter count and its source (Hugging Face, open weights only). */
  params?: number;
  paramsSource?: string;
  hfArchitecture?: string;
  knowledgeCutoff?: string;
  huggingFaceId?: string;
  canonicalSlug?: string;
  url?: string;
  reasoning?: { mandatory?: boolean; default_enabled?: boolean; supported_efforts?: string[]; default_effort?: string };
  supportedParameters?: string[];
  moderated?: boolean;
  benchmarks?: Record<string, unknown>;
}

export interface ModelDetailsView {
  id: string;
  name: string;
  provider: string;
  /** How the UI names that provider ("GLM (Z.AI)", "OpenRouter"). */
  providerLabel: string;
  modality?: string;
  enabled: boolean;
  deprecated: boolean;
  price: { input: number; output: number; source: 'openrouter' | 'vendor' } | null;
  details: GeneratedDetails | null;
  info: ModelInfo | null;
  /** When the generated part was produced. */
  asOf: string | null;
  detailsSource: 'openrouter' | 'none';
}

interface DetailsFile {
  source?: string;
  generatedAt?: string;
  models?: Record<string, GeneratedDetails>;
}

function resolveDetailsPath(): string {
  const cwdPath = path.resolve(process.cwd(), 'model-details.json');
  if (fs.existsSync(cwdPath)) return cwdPath;
  // Fallback: relative to this module, for a global install whose cwd is elsewhere.
  return path.resolve(__dirname, '..', 'model-details.json');
}

let cache: DetailsFile | null = null;
let cacheMtime = 0;

function loadDetails(): DetailsFile {
  try {
    const stat = fs.statSync(resolveDetailsPath());
    if (cache && stat.mtimeMs <= cacheMtime) return cache;
    cache = JSON.parse(fs.readFileSync(resolveDetailsPath(), 'utf-8')) as DetailsFile;
    cacheMtime = stat.mtimeMs;
    return cache ?? {};
  } catch {
    return {};
  }
}

/**
 * Parameter count per model id, for the list views that show a size next to the price.
 * One cached read of the generated file; a model without a Hugging Face card is simply
 * absent — the row shows nothing rather than a guess.
 */
export function getModelParams(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, details] of Object.entries(loadDetails().models ?? {})) {
    if (typeof details.params === 'number' && details.params > 0) out[id] = details.params;
  }
  return out;
}

/** The merged view for one model id, or null when the catalogue does not carry it. */
export function getModelDetails(id: string): ModelDetailsView | null {
  const entry = loadModelsConfig().find((m) => m.id === id);
  if (!entry) return null;

  const file = loadDetails();
  const details = file.models?.[id] ?? null;
  const pricing = getPricing(id);
  const info = entry.info ?? null;

  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    providerLabel: providerLabel(entry.provider),
    modality: entry.modality,
    enabled: entry.enabled,
    deprecated: entry.deprecated === true,
    price: pricing ? { ...pricing, source: id.startsWith('openrouter/') ? 'openrouter' : 'vendor' } : null,
    details,
    info,
    asOf: file.generatedAt ?? null,
    detailsSource: details ? 'openrouter' : 'none',
  };
}
