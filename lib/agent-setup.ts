/**
 * Olympus Agent Setup — Centralized volumes & config guarantees.
 *
 * Every Olympus-managed agent gets a fixed set of bind mounts + a
 * guaranteed set of OpenClaw config keys.  This module is the single
 * source of truth; both the "create" and "recreate" API routes import
 * from here so that a future volume or mandatory config key is a
 * one-file change.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

// ── Volumes ──────────────────────────────────────────────────────────────────

export interface OlympusVolume {
  /** Absolute host path (e.g. /docker/shared-skills). */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  /** Mount mode — "ro" for read-only, "rw" for read-write. */
  mode: 'ro' | 'rw';
}

/**
 * Fixed volumes mounted into every Olympus agent container.
 * Append entries here to add a new shared volume across all agents.
 */
export const OLYMPUS_VOLUMES: OlympusVolume[] = [
  {
    source: '/docker/shared-skills',
    target: '/data/.openclaw/shared-skills',
    mode: 'ro',
  },
  {
    source: '/docker/olympus-rules',
    target: '/root/.openclaw/workspace/.olympus',
    mode: 'ro',
  },
];

// ── Mount flags ──────────────────────────────────────────────────────────────

/**
 * Return an array of `-v source:target:mode` flags ready for `docker run`.
 */
export function getMountFlags(): string[] {
  const flags: string[] = [];
  for (const vol of OLYMPUS_VOLUMES) {
    flags.push('-v', `${vol.source}:${vol.target}:${vol.mode}`);
  }
  return flags;
}

// ── Host directory bootstrap ─────────────────────────────────────────────────

/**
 * Create every host-side source directory if it doesn't exist.
 * Called once during `olympus serve` preflight; safe to call
 * multiple times.
 */
export function ensureHostDirs(): void {
  for (const vol of OLYMPUS_VOLUMES) {
    if (!fs.existsSync(vol.source)) {
      try {
        execSync(`sudo mkdir -p ${escapeShell(vol.source)}`, { stdio: 'pipe' });
      } catch {
        execSync(`mkdir -p ${escapeShell(vol.source)}`, { stdio: 'pipe' });
      }
    }
  }
}

// ── Runtime config guarantees ────────────────────────────────────────────────

/**
 * JSON patch payloads that MUST be present in every agent's openclaw.json.
 * Each entry is a deep-merge patch applied via `openclaw config patch --stdin`.
 *
 * Ordered intentionally: provider config (which can vary per host) goes last
 * so it can reference earlier-merged keys if needed.
 */
const GUARANTEED_CONFIG_PATCHES: object[] = [
  // Olympus system rules hook — loads .olympus/*.md into every session
  {
    hooks: {
      internal: {
        entries: {
          'bootstrap-extra-files': {
            enabled: true,
            paths: ['.olympus/*.md'],
          },
        },
      },
    },
  },
  // Extra skill directories (shared across all agents)
  {
    skills: {
      load: {
        extraDirs: ['/data/.openclaw/shared-skills'],
      },
    },
  },
];

/**
 * Apply all guaranteed config patches to a running container.
 * Uses `openclaw config patch --stdin` (deep-merge) so existing
 * user customizations are never overwritten.
 */
export function applyRuntimeConfig(containerName: string): void {
  for (const patch of GUARANTEED_CONFIG_PATCHES) {
    const json = JSON.stringify(patch);
    try {
      execSync(
        `docker exec -i ${escapeShell(containerName)} sh -c 'openclaw config patch --stdin'`,
        { timeout: 15_000, stdio: 'pipe', input: json },
      );
    } catch {
      // config patch is best-effort — the image may already have it
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function escapeShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
