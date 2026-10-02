/**
 * Model pricing data — static, from model-pricing.json in the project root, in $ per
 * 1M tokens. `npm run refresh:pricing` regenerates the OpenRouter entries; the direct
 * vendors' entries are kept by hand from each vendor's own pricing page.
 *
 * Besides the display, these prices are what every agent's OpenClaw computes its costs
 * with: `buildRev4aProviderConfig()` writes `priceAt()` into each model of the synced
 * `rev4a` block, and a vendor with time-of-day pricing (PRICE_SCHEDULES) is re-synced
 * at each change of rate (lib/price-schedule-sync.ts).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ModelPricing {
  input: number;
  output: number;
  /** Cached input read. Absent when the vendor's cache rate is not known. */
  cacheRead?: number;
  /** Cached input written. Absent when not known or not billed apart from input. */
  cacheWrite?: number;
}

/** The four rates OpenClaw's `models.providers.*.models[].cost` takes, $ per 1M tokens. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * A vendor whose rates depend on the time of day: `peak` windows at the listed rates,
 * every other hour at `offPeakFactor` times them. Hours are UTC, `[from, to)`; days are
 * UTC weekdays, 0 = Sunday.
 */
export interface PriceSchedule {
  source: string;
  peak: { days: number[]; hours: [number, number][] };
  offPeakFactor: number;
}

/**
 * Keyed by the first segment of our model id: `deepseek/deepseek-flash` is DeepSeek's
 * own API. `openrouter/deepseek/…` is OpenRouter's price and has no schedule.
 *
 * DeepSeek (checked 2026-09-27): "Off-peak rates are half of the peak rates. Peak hours
 * are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese
 * public holidays." Those holidays are not modelled: a call on one is priced at peak, a
 * small overestimate on a few days a year.
 */
export const PRICE_SCHEDULES: Record<string, PriceSchedule> = {
  deepseek: {
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    peak: { days: [1, 2, 3, 4, 5], hours: [[1, 4], [6, 10]] },
    offPeakFactor: 0.5,
  },
};

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

/** The time-of-day schedule a model is billed on, or null for a flat price. */
export function priceScheduleFor(modelId: string): PriceSchedule | null {
  // Own keys only: an id segment like "constructor" must not find Object.prototype.
  const vendor = modelId.split('/')[0];
  return Object.hasOwn(PRICE_SCHEDULES, vendor) ? PRICE_SCHEDULES[vendor] : null;
}

function isPeak(schedule: PriceSchedule, at: Date): boolean {
  if (!schedule.peak.days.includes(at.getUTCDay())) return false;
  const h = at.getUTCHours();
  return schedule.peak.hours.some(([from, to]) => h >= from && h < to);
}

/** 'peak' or 'off-peak' for a model on a schedule, null for a flat price. */
export function priceBandAt(modelId: string, at: Date = new Date()): 'peak' | 'off-peak' | null {
  const schedule = priceScheduleFor(modelId);
  if (!schedule) return null;
  return isPeak(schedule, at) ? 'peak' : 'off-peak';
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * What a free model is written with. OpenClaw treats an all-zero cost as "no price" and
 * counts every call as unpriced, which would flag free models as missing a price. One
 * millionth of a dollar per 1M tokens makes them priced and, in practice, free: a billion
 * tokens come to $0.001.
 */
const FREE_RATE = 0.000001;
/**
 * A cache write with no published rate, as a multiple of the input rate. Vendors that
 * bill cache writes apart charge more than input (Anthropic: 1.25× for its default
 * five-minute cache); the ones that do not report cache writes at all never use it.
 */
const CACHE_WRITE_FALLBACK = 1.25;

/**
 * The rates in force for a model at a moment, in the shape OpenClaw's config takes.
 *
 * Null when there is nothing to write: no entry, or a dynamic router price (-1), whose
 * calls OpenClaw then counts as unpriced. A free model (all zero) gets FREE_RATE. A cache
 * rate the file does not carry falls back to a rate that does not undercount: the input
 * rate for a cache read (as if the cache gave no discount), CACHE_WRITE_FALLBACK × input
 * for a cache write.
 */
export function priceAt(modelId: string, at: Date = new Date()): ModelCost | null {
  const p = getPricing(modelId);
  if (!p || p.input < 0 || p.output < 0) return null;
  if (p.input === 0 && p.output === 0 && !p.cacheRead && !p.cacheWrite) {
    return { input: FREE_RATE, output: FREE_RATE, cacheRead: FREE_RATE, cacheWrite: FREE_RATE };
  }
  const schedule = priceScheduleFor(modelId);
  const factor = schedule && !isPeak(schedule, at) ? schedule.offPeakFactor : 1;
  return {
    input: round6(p.input * factor),
    output: round6(p.output * factor),
    cacheRead: round6((p.cacheRead ?? p.input) * factor),
    cacheWrite: round6((p.cacheWrite ?? p.input * CACHE_WRITE_FALLBACK) * factor),
  };
}

/**
 * The next moment any of these models changes rate, or null when none is on a schedule.
 * Every schedule changes on the hour, so the search walks hour marks (up to 8 days).
 */
export function nextPriceChange(modelIds: string[], from: Date = new Date()): Date | null {
  const schedules = [...new Set(modelIds.map(priceScheduleFor).filter((s): s is PriceSchedule => s !== null))];
  if (!schedules.length) return null;
  const now = schedules.map((s) => isPeak(s, from));
  const t = new Date(from);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 8 * 24; i++) {
    t.setUTCHours(t.getUTCHours() + 1);
    if (schedules.some((s, j) => isPeak(s, t) !== now[j])) return new Date(t);
  }
  return null;
}
