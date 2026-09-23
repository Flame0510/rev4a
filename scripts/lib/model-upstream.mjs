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
  const stripped = id.slice('openrouter/'.length);
  return stripped === id ? [id] : [stripped, id];
}

/** Try the id with its version separators swapped: `claude-haiku-4-5` ↔ `claude-haiku-4.5`. */
export function separatorVariants(id) {
  return [
    id.replace(/-(\d+)-(\d+)$/, '-$1.$2'),
    id.replace(/-(\d+)\.(\d+)$/, '-$1-$2'),
  ].filter((v) => v !== id);
}

/** The upstream entry a catalogue id corresponds to, or null. */
export function matchUpstream(live, id) {
  for (const candidate of upstreamCandidates(id)) if (live.has(candidate)) return live.get(candidate);
  const slash = id.indexOf('/');
  const alias = slash > 0 ? VENDOR_ALIAS[id.slice(0, slash)] : undefined;
  const rest = slash > 0 ? id.slice(slash + 1) : '';
  if (alias && live.has(`${alias}/${rest}`)) return live.get(`${alias}/${rest}`);
  const mapped = MODEL_ALIAS[id];
  if (mapped && live.has(mapped)) return live.get(mapped);
  for (const variant of separatorVariants(id)) if (live.has(variant)) return live.get(variant);
  return null;
}

/** Fetch the whole upstream catalogue once. Throws when the response is not a catalogue. */
export async function fetchUpstream() {
  const res = await fetch(CATALOGUE_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Catalogue returned HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data) || body.data.length === 0) throw new Error('Unexpected catalogue shape');
  return new Map(body.data.map((m) => [m.id, m]));
}
