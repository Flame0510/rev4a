/**
 * Rev4a Agent Setup — Centralized volumes & config guarantees.
 *
 * Every Rev4a-managed agent gets a fixed set of bind mounts + a
 * guaranteed set of OpenClaw config keys.  This module is the single
 * source of truth; both the "create" and "recreate" API routes import
 * from here so that a future volume or mandatory config key is a
 * one-file change.
 */

import * as fs from 'fs';
import { SHARED_SKILLS_DIR, REV4A_RULES_DIR, ensureBackupsDir } from '@/lib/rev4a-paths';
import { dockerExec, dockerExecWithInput } from '@/lib/docker-exec';
import { reapplyWhenReady } from '@/lib/credentials/delivery';
import { withAgentConfigLock } from '@/lib/agent-config-lock';

// ── Volumes ──────────────────────────────────────────────────────────────────

export interface Rev4aVolume {
  /** Absolute host path (e.g. /docker/shared-skills). */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  /** Mount mode — "ro" for read-only, "rw" for read-write. */
  mode: 'ro' | 'rw';
}

/**
 * Fixed volumes mounted into every Rev4a agent container.
 * Append entries here to add a new shared volume across all agents.
 */
export const REV4A_VOLUMES: Rev4aVolume[] = [
  {
    source: SHARED_SKILLS_DIR,
    target: '/data/.openclaw/shared-skills',
    mode: 'ro',
  },
  {
    source: REV4A_RULES_DIR,
    target: '/root/.openclaw/workspace/.rev4a',
    mode: 'ro',
  },
];

// ── Mount flags ──────────────────────────────────────────────────────────────

/**
 * Return an array of `-v source:target:mode` flags ready for `docker run`.
 */
export function getMountFlags(): string[] {
  const flags: string[] = [];
  for (const vol of REV4A_VOLUMES) {
    flags.push('-v', `${vol.source}:${vol.target}:${vol.mode}`);
  }
  return flags;
}

// ── Host directory bootstrap ─────────────────────────────────────────────────

/**
 * Create every host-side source directory if it doesn't exist.
 * Called once during `rev4a serve` preflight; safe to call
 * multiple times.
 */
export function ensureHostDirs(): void {
  // Plain mkdir: these now live under the user's own data directory, so no
  // elevation is needed. The previous `sudo mkdir` with a plain fallback was
  // only required because the paths sat at the filesystem root, and it could
  // hang on a password prompt when run non-interactively.
  for (const vol of REV4A_VOLUMES) {
    fs.mkdirSync(vol.source, { recursive: true });
  }
  ensureBackupsDir();
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
  // Rev4a system rules hook — loads .rev4a/*.md into every session
  {
    hooks: {
      internal: {
        entries: {
          'bootstrap-extra-files': {
            enabled: true,
            paths: ['.rev4a/*.md'],
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

const CONFIG_PATCH_TIMEOUT_MS = 15_000;

/** Exactly `["*"]`: the allow-all list earlier Rev4a versions wrote. */
function isWildcardOnly(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === '*';
}

/**
 * `gateway.controlUi` with Rev4a's browser-origin policy applied.
 *
 * The Host-header fallback accepts a Control UI page served from the host the
 * browser connected to — whatever address the agent is reached on — and refuses
 * pages from any other origin. Without it, a public IP is refused; loopback and
 * private hosts are accepted either way. An `allowedOrigins: ["*"]` list, which
 * accepts every origin, is dropped; any other list an operator set is kept. The
 * retired `dangerouslyDisableDeviceAuth` is dropped too.
 */
export function withControlUiPolicy(current: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}),
  };
  next.dangerouslyAllowHostHeaderOriginFallback = true;
  delete next.dangerouslyDisableDeviceAuth;
  if (isWildcardOnly(next.allowedOrigins)) delete next.allowedOrigins;
  return next;
}

/** One `config patch`. Callers hold the agent's config lock (see lib/agent-config-lock.ts). */
async function patchConfig(containerName: string, patch: object): Promise<void> {
  await dockerExecWithInput(containerName, ['openclaw', 'config', 'patch', '--stdin'], JSON.stringify(patch), {
    timeoutMs: CONFIG_PATCH_TIMEOUT_MS,
  });
}

/**
 * Apply the origin policy to a running container through merge patches.
 *
 * The fallback and the removal of `["*"]` go in one patch, so the Gateway reloads
 * both together. The retired `dangerouslyDisableDeviceAuth` goes in a second patch:
 * if the Gateway refuses it, the policy the Control UI needs is already in place.
 */
async function applyControlUiPolicy(containerName: string): Promise<void> {
  // Read and patches under one hold: the policy is decided from what the read returned.
  await withAgentConfigLock(containerName, () => applyControlUiPolicyLocked(containerName));
}

async function applyControlUiPolicyLocked(containerName: string): Promise<void> {
  const raw = await dockerExec(containerName, ['cat', '/root/.openclaw/openclaw.json'], { timeoutMs: CONFIG_PATCH_TIMEOUT_MS });
  const current = (JSON.parse(raw) as { gateway?: { controlUi?: Record<string, unknown> } })?.gateway?.controlUi ?? {};

  const policy: Record<string, unknown> = { dangerouslyAllowHostHeaderOriginFallback: true };
  if (isWildcardOnly(current.allowedOrigins)) policy.allowedOrigins = null;
  await patchConfig(containerName, { gateway: { controlUi: policy } });

  if ('dangerouslyDisableDeviceAuth' in current) {
    await patchConfig(containerName, { gateway: { controlUi: { dangerouslyDisableDeviceAuth: null } } });
  }
}

/**
 * Apply all guaranteed config patches to a running container, then the origin policy.
 * Uses `openclaw config patch --stdin` (deep-merge) so existing
 * user customizations are never overwritten. Best-effort: a failed patch is logged
 * and the others still run. Ends by starting, in the background, the re-apply of the agent's credential assignments.
 */
export async function applyRuntimeConfig(containerName: string): Promise<void> {
  for (const patch of GUARANTEED_CONFIG_PATCHES) {
    try {
      await withAgentConfigLock(containerName, () => patchConfig(containerName, patch));
    } catch (e) {
      console.warn(`[agent-setup] config patch failed on ${containerName}:`, (e as Error).message);
    }
  }
  try {
    await applyControlUiPolicy(containerName);
  } catch (e) {
    console.warn(`[agent-setup] Control UI origin policy not applied on ${containerName}:`, (e as Error).message);
  }
  // Credentials switched on for this agent (secret store + skill config). Not awaited: the
  // calls take seconds and create, recreate, update and edit must not wait for them. The
  // assignments are the source of truth; each outcome is kept on its own assignment.
  void reapplyWhenReady(containerName).catch((e) => {
    console.warn(`[agent-setup] credentials not re-applied on ${containerName}:`, (e as Error).message);
  });
}
