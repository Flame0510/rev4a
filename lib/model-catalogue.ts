/**
 * Model catalogue — bundle-first + user-overrides.
 *
 * Reads the bundled models.config.json from the npm package and applies
 * user toggles from REV4A_DATA/model-overrides.json.
 *
 * Imported by both provider/route.ts and gateway/sync.ts — shared logic,
 * avoids circular dependencies.
 */
import * as fs from 'fs';
import * as path from 'path';
import { REV4A_DATA } from '@/lib/rev4a-paths';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ModelConfigEntry {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  modality?: string;
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

function loadBundledModels(): ModelConfigEntry[] {
  try {
    const raw = fs.readFileSync(resolveBundledPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.models)) {
      return parsed.models.map((m: Record<string, unknown>) => ({
        id: String(m.id ?? ''),
        name: String(m.name ?? ''),
        provider: String(m.provider ?? ''),
        enabled: Boolean(m.enabled),
        modality: typeof m.modality === 'string' ? m.modality : undefined,
      }));
    }
  } catch { /* fall through */ }
  return [];
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
 * The bundle is read-only at runtime. User choices live in model-overrides.json.
 */
export function loadModelsConfig(): ModelConfigEntry[] {
  const bundled = loadBundledModels();
  const overrides = loadOverrides();

  // Clean up orphan overrides (models removed from bundle)
  const bundledIds = new Set(bundled.map((m) => m.id));
  let dirty = false;
  for (const id of Object.keys(overrides)) {
    if (!bundledIds.has(id)) {
      delete overrides[id];
      dirty = true;
    }
  }
  if (dirty) writeOverrides(overrides);

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
  writeOverrides(overrides);
  return true;
}
