/**
 * Live pricing for OpenRouter-hosted models.
 *
 * model-pricing.json is maintained by hand and drifts: at the time this was
 * written, 16 of 79 OpenRouter entries disagreed with the live catalogue —
 * one of them (google/gemini-2.5-flash) understated the real cost by ~8x.
 * The static file stays as the offline fallback; this overlays it when the
 * catalogue is reachable.
 *
 * Scope is deliberately narrow: only models whose provider is `openrouter`.
 * OpenRouter resells models that we ALSO offer direct (openai, anthropic,
 * google, …) at different rates, so applying these prices to a direct
 * provider entry would show the wrong vendor's price.
 *
 * Only pricing is taken from upstream — NOT modality. app/api/gateway/sync.ts
 * provisions agent containers from the curated models.config.json value, so
 * showing a different capability set in the UI would advertise inputs the
 * container was never configured to accept.
 *
 * The endpoint is public (no API key, served from CDN) — calling it costs
 * nothing and is never billed.
 */

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
// The call measures ~300ms against the CDN, so 3s is ~10x headroom. A longer
// limit wouldn't protect anything — it would just hold the response open when
// the catalogue is unreachable, and the static file is a fine stand-in.
const FETCH_TIMEOUT_MS = 3000;

// Mirrors the cache policy OpenRouter declares on the endpoint itself:
//   cache-control: public, max-age=300, stale-while-revalidate=3600, stale-if-error=3600
const TTL_MS = 5 * 60 * 1000; // max-age=300
const MAX_STALE_MS = 60 * 60 * 1000; // stale-if-error=3600
// After a failure, don't retry on every single request — an unreachable
// catalogue would otherwise make each one pay the full abort timeout.
const RETRY_AFTER_FAILURE_MS = 60 * 1000;

export interface LivePricing {
  input: number; // USD per 1M prompt tokens
  output: number; // USD per 1M completion tokens
}

interface OpenRouterModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
}

interface CacheEntry {
  pricing: Map<string, LivePricing>;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let lastFailureAt = 0;
let inFlight: Promise<CacheEntry | null> | null = null;

/** OpenRouter quotes per-token; the UI works in per-million. */
function perMillion(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  // -1 means "dynamic" (router models); not a real price, leave it to the
  // static file which already encodes it as -1/-1 and renders as "Dynamic".
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

async function fetchCatalogue(): Promise<CacheEntry | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CATALOGUE_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[openrouter-pricing] catalogue returned HTTP ${res.status}`);
      return null;
    }

    const body = (await res.json()) as { data?: OpenRouterModel[] };
    if (!Array.isArray(body?.data)) {
      console.warn('[openrouter-pricing] unexpected catalogue shape');
      return null;
    }

    const pricing = new Map<string, LivePricing>();
    for (const m of body.data) {
      if (!m?.id) continue;
      const input = perMillion(m.pricing?.prompt);
      const output = perMillion(m.pricing?.completion);
      if (input !== null && output !== null) pricing.set(m.id, { input, output });
    }

    if (pricing.size === 0) return null;
    return { pricing, fetchedAt: Date.now() };
  } catch (e) {
    const reason = e instanceof Error ? e.name : 'unknown';
    console.warn(`[openrouter-pricing] catalogue unreachable (${reason}) — using static prices`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isUsable(entry: CacheEntry | null): entry is CacheEntry {
  // Past stale-if-error we stop trusting it entirely and fall back to the
  // static file, rather than labelling day-old numbers as live.
  return !!entry && Date.now() - entry.fetchedAt < MAX_STALE_MS;
}

/**
 * Cached catalogue, refreshed when stale. Concurrent callers share one
 * in-flight request. A failure is remembered so an unreachable catalogue
 * doesn't make every request pay the timeout; the previous entry keeps
 * being served until it exceeds the stale-if-error window.
 */
async function getCatalogue(): Promise<CacheEntry | null> {
  const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;
  if (fresh) return cache;

  if (inFlight) return inFlight;

  // Backing off after a recent failure — serve what we have, if still usable.
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    return isUsable(cache) ? cache : null;
  }

  inFlight = fetchCatalogue()
    .then((result) => {
      if (result) {
        cache = result;
        lastFailureAt = 0;
      } else {
        lastFailureAt = Date.now();
      }
      return isUsable(cache) ? cache : null;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Map one of our ids to the upstream one.
 *
 * Our catalogue namespaces OpenRouter entries as `openrouter/<upstream id>`,
 * but OpenRouter also publishes its own house models under a literal
 * `openrouter/` vendor prefix (`openrouter/auto`, `openrouter/auto-beta`, …).
 * Stripping unconditionally turns `openrouter/auto` into `auto`, which does
 * not exist upstream — so try the stripped form first and fall back to the
 * id as-is.
 */
function candidateUpstreamIds(modelId: string): string[] {
  if (!modelId.startsWith('openrouter/')) return [];
  const stripped = modelId.slice('openrouter/'.length);
  return stripped === modelId ? [modelId] : [stripped, modelId];
}

/**
 * Pricing overlay keyed by OUR model ids, for the OpenRouter-hosted subset.
 * Returns an empty map when the catalogue can't be reached — never throws.
 */
export async function getLivePricing(modelIds: string[]): Promise<Map<string, LivePricing>> {
  const overlay = new Map<string, LivePricing>();

  const wanted = modelIds.filter((id) => id.startsWith('openrouter/'));
  if (wanted.length === 0) return overlay;

  const catalogue = await getCatalogue();
  if (!catalogue) return overlay;

  for (const ourId of wanted) {
    for (const upstreamId of candidateUpstreamIds(ourId)) {
      const price = catalogue.pricing.get(upstreamId);
      if (price) {
        overlay.set(ourId, price);
        break;
      }
    }
  }
  return overlay;
}
