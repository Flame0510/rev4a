/**
 * Model catalogue — bundle-first + user-overrides.
 *
 * Reads the bundled models.config.json from the npm package and applies
 * user toggles from REV4A_DATA/model-overrides.json. The only module that reads
 * either file: routes, pages and the sync all go through it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { REV4A_DATA } from '@/lib/rev4a-paths';
import { readProviderKeys } from '@/app/api/gateway/provider/keys';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ModelConfigEntry {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  modality?: string;
  /** Upstream has retired this id. It still answers, but is redirected. */
  deprecated?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Path helpers                                                        */
/* ------------------------------------------------------------------ */

/** Absolute path to model-overrides.json in REV4A_DATA. */
function overridesPath(): string {
  return path.join(REV4A_DATA, 'model-overrides.json');
}

/** Resolve the bundled models.config.json (in the npm package). */
function resolveBundledPath(): string {
  // cwd first (works with systemd WorkingDirectory pointed at the repo / project)
  const cwdPath = path.resolve(process.cwd(), 'models.config.json');
  if (fs.existsSync(cwdPath)) return cwdPath;
  // Fallback: relative to this module (lib/ → project root)
  return path.resolve(__dirname, '..', 'models.config.json');
}

/* ------------------------------------------------------------------ */
/*  Loaders                                                             */
/* ------------------------------------------------------------------ */

/** Last catalogue read successfully by this process. */
let lastGoodBundle: ModelConfigEntry[] | null = null;

/** How the most recent read of models.config.json went. */
let bundleStatus: 'ok' | 'stale' | 'unavailable' = 'ok';

/**
 * Where the last catalogue read left us:
 * - `ok`          the file was read and parsed
 * - `stale`       the read failed; this process's last good copy was used
 * - `unavailable` the read failed with no earlier copy, so the catalogue is empty
 */
export function bundledCatalogueStatus(): 'ok' | 'stale' | 'unavailable' {
  return bundleStatus;
}

/**
 * The bundled catalogue.
 *
 * A failed read must not look like an empty catalogue. It used to: this returned
 * `[]`, the loader then treated every user override as an orphan and deleted them
 * all from disk, the sync pushed an empty model list into every agent, and the
 * proxy refused every request. One unlucky read — the pricing script rewriting the
 * file in place, a malformed release — was enough. A failed read now falls back to
 * the last good copy and reports it through `bundledCatalogueStatus()`.
 */
function loadBundledModels(): ModelConfigEntry[] {
  try {
    const raw = fs.readFileSync(resolveBundledPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
      throw new Error('no models array');
    }
    const models: ModelConfigEntry[] = parsed.models.map((m: Record<string, unknown>) => ({
      id: String(m.id ?? ''),
      name: String(m.name ?? ''),
      provider: String(m.provider ?? ''),
      enabled: Boolean(m.enabled),
      modality: typeof m.modality === 'string' ? m.modality : undefined,
      deprecated: m.deprecated === true ? true : undefined,
    }));
    lastGoodBundle = models;
    bundleStatus = 'ok';
    return models;
  } catch (e) {
    const why = (e as Error).message;
    if (lastGoodBundle) {
      if (bundleStatus !== 'stale') console.warn(`[model-catalogue] models.config.json unreadable, using the last good copy: ${why}`);
      bundleStatus = 'stale';
      return lastGoodBundle;
    }
    if (bundleStatus !== 'unavailable') console.error(`[model-catalogue] models.config.json unreadable and no earlier copy: ${why}`);
    bundleStatus = 'unavailable';
    return [];
  }
}

export function loadOverrides(): Record<string, boolean> {
  try {
    if (!fs.existsSync(overridesPath())) return {};
    const raw = fs.readFileSync(overridesPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'boolean') out[k] = v;
      }
      return out;
    }
  } catch { /* ignore */ }
  return {};
}

export function writeOverrides(overrides: Record<string, boolean>): void {
  if (!fs.existsSync(REV4A_DATA)) {
    fs.mkdirSync(REV4A_DATA, { recursive: true });
  }
  fs.writeFileSync(overridesPath(), JSON.stringify(overrides, null, 2), 'utf-8');
}

/**
 * Load the full model catalogue:
 * 1. Read models.config.json from the npm package (bundle).
 * 2. Apply user overrides (enabled/disabled toggles).
 *
 * Read-only. Overrides for ids the bundle no longer has are ignored here and
 * pruned only by `toggleModelOverride`, against a fresh read: this runs on every
 * proxy request, and a read path that deletes user settings is one failed read
 * away from deleting all of them.
 */
export function loadModelsConfig(): ModelConfigEntry[] {
  const bundled = loadBundledModels();
  const overrides = loadOverrides();
  return bundled.map((m) => ({
    ...m,
    enabled: Object.prototype.hasOwnProperty.call(overrides, m.id) ? overrides[m.id] : m.enabled,
  }));
}

/** Save a single model toggle (writes to model-overrides.json). */
export function toggleModelOverride(modelId: string, enabled: boolean): boolean {
  const overrides = loadOverrides();
  const bundled = loadBundledModels();
  const bm = bundled.find((m) => m.id === modelId);
  if (!bm) return false; // unknown model

  if (enabled === bm.enabled) {
    // Reset to default → remove key (keeps file clean)
    delete overrides[modelId];
  } else {
    overrides[modelId] = enabled;
  }

  // Drop overrides for models the catalogue no longer has — but only against a
  // catalogue read just now. Against a stale or missing copy every override
  // would look orphaned.
  if (bundledCatalogueStatus() === 'ok') {
    const ids = new Set(bundled.map((m) => m.id));
    for (const id of Object.keys(overrides)) if (!ids.has(id)) delete overrides[id];
  }

  writeOverrides(overrides);
  return true;
}

/**
 * The models this deployment actually offers.
 *
 * Two conditions, and they are separate questions:
 *
 *  - **enabled** — policy. What the operator wants offered, `models.config.json`
 *    as the default and `model-overrides.json` as their decision on top.
 *  - **provider has a key** — availability. Offering a model nobody can be billed
 *    for produces a runtime failure at the worst moment.
 *
 * This exists because four readers each answered it differently, and the answers
 * mattered. Measured on the production host, which has keys for four providers
 * and eight overrides that all diverge from the bundled default: the create
 * wizard listed 58 models where the correct answer was 62, offering two the
 * operator had switched off and hiding six they had switched on. It read the
 * bundle directly and never opened the overrides file. Meanwhile
 * `/api/provider/v1/models` applied the overrides but not the key filter, so it
 * advertised models for providers with no credentials.
 *
 * Callers still shape the result themselves — the sync adds `input` modalities,
 * the pickers add prices — but the *set* is decided here, once.
 */
export function loadOfferedModels(): ModelConfigEntry[] {
  const configured = new Set(Object.keys(readProviderKeys()));
  return loadModelsConfig().filter((m) => {
    if (!m.enabled) return false;
    if (configured.has(m.provider)) return true;
    // A `rev4a/*` alias bills through DeepSeek upstream, so a DeepSeek key is
    // enough to offer one. The catalogue currently defines none.
    if (m.provider === 'rev4a' && configured.has('deepseek')) return true;
    return false;
  });
}

/**
 * May this deployment serve a request for this model?
 *
 * `loadOfferedModels` answers what to *show*; this answers what to *honour*. They
 * were the same question asked in two places and only the first was ever asked:
 * the proxy and the assistant took whatever model the caller named and billed it.
 * Unchecking a model on the Gateway page removed it from every picker and stopped
 * nothing, because a client that already held the id — a stale in-memory list, a
 * saved preference, an agent configured before the change — kept working.
 *
 * Takes the *resolved* pair, not the raw string. Callers reach it through
 * `extractProviderAndModel`, which collapses `rev4a/deepseek/deepseek-flash`,
 * `deepseek/deepseek-flash` and the two-segment alias `rev4a/deepseek-flash` onto
 * one provider and model, so all three are tested as the same catalogue id.
 */
export function isModelOffered(provider: string, model: string): boolean {
  const id = `${provider}/${model}`;
  return loadOfferedModels().some((m) => m.id === id);
}

/**
 * Where a model id stands against the catalogue, for explaining a failure.
 *
 * - `offered`  — enabled and its provider has a key; the proxy serves it
 * - `disabled` — in the catalogue but not offered: unchecked, or no key
 * - `missing`  — not in the catalogue at all, e.g. removed in a release
 *
 * Takes a bare id, without the `rev4a/` prefix. The Model panel used to infer the
 * cause from the offered list alone, so a model removed from the catalogue was
 * explained as "unchecked, or its provider has no key" while the card said
 * `NOT IN CATALOGUE`. `models-summary` computes the same two sets once for the
 * whole fleet instead of calling this per agent.
 */
export function catalogueStatus(id: string): 'offered' | 'disabled' | 'missing' {
  if (!loadModelsConfig().some((m) => m.id === id)) return 'missing';
  return loadOfferedModels().some((m) => m.id === id) ? 'offered' : 'disabled';
}
