/**
 * Upstream (OpenRouter) catalogue lookup, shared by `refresh-model-pricing.mjs` and
 * `model-info-suggest.mjs`: one place decides which upstream entry a catalogue id
 * corresponds to, so a model is never matched two different ways.
 *
 * No dependencies, public endpoint, no API key (see docs/dev/GATEWAY.md).
 */

export const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';

/**
 * A direct provider's OpenRouter vendor name, when it differs from ours:
 * `glm/glm-5.3` is `z-ai/glm-5.3` upstream, `kimi/kimi-k3` is `moonshotai/kimi-k3`.
 * For details and docs only — prices for direct entries come from the vendor's own list.
 */
export const VENDOR_ALIAS = { glm: 'z-ai', kimi: 'moonshotai' };

/**
 * Same model, different name on OpenRouter. Only exact same-model cases belong here: a
 * different tier (`-highspeed`) or another vendor's copy of the weights is a curated
 * `info` block, not an alias, because description and benchmarks would be someone else's.
 */
export const MODEL_ALIAS = {
  'deepseek/deepseek-flash': 'deepseek/deepseek-v4.1-flash', // our name for DeepSeek's V4.1
};

/** Our catalogue namespaces OpenRouter entries as `openrouter/<id>`; the router itself is `openrouter/auto`. */
export function upstreamCandidates(id) {
  return id.startsWith('openrouter/') ? [id.slice('openrouter/'.length), id] : [id];
}

function variantSuffix(id) {
  const colon = id.indexOf(':');
  return colon === -1 ? '' : id.slice(colon);
}

/** Swap version separators in the model name while preserving its variant suffix. */
export function separatorVariants(id) {
  const suffix = variantSuffix(id);
  const name = id.slice(0, id.length - suffix.length);
  return [
    name.replace(/-(\d+)-(\d+)$/, '-$1.$2'),
    name.replace(/-(\d+)\.(\d+)$/, '-$1-$2'),
  ].filter((variant) => variant !== name).map((variant) => variant + suffix);
}

/** The upstream entry a catalogue id corresponds to, or null. */
export function matchUpstream(live, id) {
  const exact = upstreamCandidates(id);
  const slash = id.indexOf('/');
  const alias = slash > 0 ? VENDOR_ALIAS[id.slice(0, slash)] : undefined;
  const candidates = [
    ...exact,
    alias && `${alias}/${id.slice(slash + 1)}`,
    MODEL_ALIAS[id],
    ...exact.flatMap(separatorVariants),
  ];
  const suffix = variantSuffix(id);
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || variantSuffix(candidate) !== suffix) continue;
    const row = live.get(candidate);
    // Standard and variant rows can share a canonical_slug. Match by the actual API ID.
    if (row?.id === candidate) return row;
  }
  return null;
}

const TIME_FIELDS = ['utc_start', 'utc_end', 'utc_days'];
const TOKEN_PRICE_FIELDS = ['prompt', 'completion', 'input_cache_read', 'input_cache_write'];
const WINDOW_FIELDS = [...TIME_FIELDS, ...TOKEN_PRICE_FIELDS, 'request', 'image', 'web_search', 'internal_reasoning'];
const UTC_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function coversWeek(windows) {
  const validClock = (time) => Number.isInteger(time) && time >= 0 && time < 2400 && time % 100 < 60;
  for (const { utc_start: start, utc_end: end, utc_days: days } of windows) {
    if ((start !== undefined || end !== undefined) && (!validClock(start) || !validClock(end))) return false;
    if (days !== undefined && (!Array.isArray(days) || !days.length || days.some((day) => !UTC_DAYS.includes(day)))) return false;
  }
  // Coverage only changes at the start or end of a window.
  const boundaries = [...new Set([0, ...windows.flatMap(({ utc_start = 0, utc_end = 0 }) => [utc_start, utc_end])])];
  return UTC_DAYS.every((day) => boundaries.every((time) => windows.filter((window) => {
    const { utc_start: start = 0, utc_end: end = 0, utc_days: days = UTC_DAYS } = window;
    const inWindow = start < end ? time >= start && time < end : time >= start || time < end;
    return days.includes(day) && inWindow;
  }).length === 1));
}

/** Use the highest complete rate row for the shortest context tier. Null requires manual review. */
export function peakOpenRouterPricing(pricing) {
  if (pricing?.overrides == null) return pricing ?? undefined;
  if (!Array.isArray(pricing.overrides)) return null;
  const timed = pricing.overrides.filter((row) => row && TIME_FIELDS.some((key) => Object.hasOwn(row, key)));
  if (!timed.length) return pricing;

  // Exclude context thresholds and unrecognized conditions from the default schedule.
  const windows = timed.filter((row) => Object.keys(row).every((key) =>
    WINDOW_FIELDS.includes(key) || (key !== 'overrides' && Object.hasOwn(pricing, key))));
  if (!coversWeek(windows)) return null;

  // Top-level rates can come from the current UTC window. Inherit a rate only if
  // no window overrides it, since in that case it is constant across the schedule.
  const inherited = Object.fromEntries(TOKEN_PRICE_FIELDS
    .filter((key) => windows.every((row) => !Object.hasOwn(row, key)))
    .map((key) => [key, pricing[key]]));
  const candidates = windows.map((row) => ({ ...inherited, ...row }));
  const rates = candidates.map((row) => TOKEN_PRICE_FIELDS.map((key) => {
    const value = row[key];
    if (value === undefined && key.startsWith('input_cache_') && Object.hasOwn(inherited, key)) return 0;
    return typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  }));
  if (rates.some((row) => row.some((rate) => !Number.isFinite(rate) || rate < 0))) return null;

  // Pick one published window. Crossing rates have no identifiable peak tuple.
  const peak = rates.findIndex((row) => rates.every((other) => other.every((rate, index) => row[index] >= rate)));
  return candidates[peak] ?? null;
}

/** Fetch the whole upstream catalogue once. Throws when the response is not a catalogue. */
export async function fetchUpstream() {
  const res = await fetch(CATALOGUE_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Catalogue returned HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data) || body.data.length === 0) throw new Error('Unexpected catalogue shape');
  return new Map(body.data.map((m) => [m.id, m]));
}
