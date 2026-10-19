/**
 * Native OpenClaw delivery, the pure half: which environment entries and which skill
 * config a provider needs, and the exact argv / JSON the delivery layer sends.
 *
 * This file imports only lib/gateway-cli.ts, which has no imports itself. It is the part a
 * test can run with plain node, and it is where the "no secret in argv" rule is enforced by
 * construction: no function here takes a secret and returns argv. A value only ever
 * leaves as the stdin text of `secrets store set`, built by {@link storeInputs}.
 */

import { gatewayCliArgv } from '../gateway-cli';

/** The Rev4a mode of an assignment. `protected` is reserved and not implemented. */
export type AssignmentMode = 'env' | 'protected';

export const ASSIGNMENT_MODES: readonly AssignmentMode[] = ['env', 'protected'];

/** Oldest OpenClaw release with `secrets store` and `skills.entries.*.apiKey` SecretRefs. */
export const NATIVE_MIN_VERSION = '2026.9.0';

export interface EnvEntry {
  /** Environment variable name, also the secret store entry name. */
  name: string;
  /** Field of the vault secret that holds the value. */
  field: string;
}

export interface SkillBinding {
  /** The bundled OpenClaw skill name (`skills.entries.<name>`). */
  name: string;
  /**
   * How the skill receives the credential:
   * - `apiKey`: SecretRef to the store entry (the skill declares a `primaryEnv`);
   * - `env`: plaintext `env` map (the skill needs several variables; SecretRefs are refused there);
   * - `none`: the skill only needs a binary, so it is just switched on.
   */
  via: 'apiKey' | 'env' | 'none';
}

export interface NativeProvider {
  env: EnvEntry[];
  skill?: SkillBinding;
  /**
   * OpenClaw version this provider needs, when it is newer than {@link NATIVE_MIN_VERSION}.
   * Trello's bundled skill runs through `curl` and `jq`, and `jq` only entered the image
   * with 2026.9.9: on an older agent the skill is not eligible, so a delivery that looked
   * successful would leave the credential unusable. Refusing the delivery tells the
   * operator to update the agent instead.
   */
  minVersion?: string;
}

export const NATIVE_PROVIDERS: Record<string, NativeProvider> = {
  // GitHub and Vercel keep no env entries on purpose: OpenClaw drops GH_TOKEN /
  // GITHUB_TOKEN (override-blocked, see managed.ts) and the Vercel CLI ignores a
  // token-only environment. Their delivery is provider-specific (managed.ts); the
  // github skill is still switched on here.
  'github-pat': {
    env: [],
    skill: { name: 'github', via: 'none' },
  },
  vercel: { env: [] },
  supabase: { env: [{ name: 'SUPABASE_ACCESS_TOKEN', field: 'accessToken' }] },
  trello: {
    env: [
      { name: 'TRELLO_API_KEY', field: 'apiKey' },
      { name: 'TRELLO_TOKEN', field: 'token' },
    ],
    skill: { name: 'trello', via: 'env' },
    minVersion: '2026.9.9',
  },
  notion: {
    env: [{ name: 'NOTION_API_TOKEN', field: 'token' }],
    skill: { name: 'notion', via: 'apiKey' },
  },
  // The name is REV4A_MONGODB_URI, never MONGODB_URI: OpenClaw drops MONGODB_URI, DATABASE_URL,
  // REDIS_URL and AMQP_URL from its exec tool on purpose (blockedOverrideOnlyKeys), so an entry
  // with the common name would exist in the store and never reach a command. The skill is
  // Rev4a's own shared skill (rev4a-skills/), not a bundled one; it is eligible only with the
  // apiKey SecretRef, and mongosh is installed by mongodb.ts before the switch-on writes anything.
  // 2026.9.9 is the only release this was verified on.
  mongodb: {
    env: [{ name: 'REV4A_MONGODB_URI', field: 'uri' }],
    skill: { name: 'rev4a-mongodb', via: 'apiKey' },
    minVersion: '2026.9.9',
  },
};

export function nativeProvider(providerId: string): NativeProvider | undefined {
  return NATIVE_PROVIDERS[providerId];
}

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

// ── argv builders: names only, never values ─────────────────────────────────────────

export function storeSetArgv(name: string): string[] {
  if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid environment name: ${name}`);
  return ['openclaw', 'secrets', 'store', 'set', name, '--kind', 'env', '--value-file', '-'];
}

export function storeRemoveArgv(name: string): string[] {
  if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid environment name: ${name}`);
  // --yes: without it a non-interactive rm prints a prompt, removes nothing and exits 0.
  return ['openclaw', 'secrets', 'store', 'rm', '--yes', name];
}

export const CONFIG_PATCH_ARGV: readonly string[] = ['openclaw', 'config', 'patch', '--stdin'];
export const SECRETS_RELOAD_ARGV: readonly string[] = ['openclaw', 'secrets', 'reload'];
/**
 * Environment for the reload: the agent's Gateway listens on port 3000, not OpenClaw's
 * default. The URL goes in the environment, never as --url/--token in argv (the token
 * would reach the process table); the token itself comes from the container env.
 */
export const SECRETS_RELOAD_ENV: Readonly<Record<string, string>> = { OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:3000' };
/**
 * The reload as it runs in the container: through the shared Gateway CLI wrapper, so the CLI
 * uses the token in /root/.agent-token (a rotated token) like the Gateway does. The plan above
 * keeps the plain command; the URL stays in the environment.
 */
export function secretsReloadExecArgv(): string[] {
  return gatewayCliArgv(SECRETS_RELOAD_ARGV.slice(1), { port: null });
}
export const VERSION_ARGV: readonly string[] = ['openclaw', '--version'];

export class UnsupportedNativeVersionError extends Error {}

// ── stdin payloads ──────────────────────────────────────────────────────────────────

/** One store entry to write: the name goes to argv, the value to stdin. */
export interface StoreInput { name: string; value: string }

/** Env entries with their values read from the vault secret. Throws on a missing value, naming the field. */
export function storeInputs(providerId: string, secret: Record<string, string>): StoreInput[] {
  const p = nativeProvider(providerId);
  if (!p) throw new Error(`No native delivery for provider: ${providerId}`);
  return p.env.map((e) => {
    const value = (secret[e.field] ?? '').trim();
    if (!value) throw new Error(`Missing ${e.field} in the stored credential`);
    return { name: e.name, value };
  });
}

/** The SecretRef OpenClaw resolves from the secret store. */
export function secretRef(name: string): { source: 'store'; provider: 'default'; id: string } {
  return { source: 'store', provider: 'default', id: name };
}

/**
 * The `openclaw config patch` body that makes the bundled skill eligible, or null when
 * the provider has no skill. For `via: 'env'` the patch holds the values in plaintext
 * (OpenClaw accepts no SecretRef there): it travels on stdin only.
 */
export function enablePatch(providerId: string, secret: Record<string, string>): object | null {
  const p = nativeProvider(providerId);
  if (!p?.skill) return null;
  const { name, via } = p.skill;
  let entry: Record<string, unknown> = { enabled: true };
  if (via === 'apiKey') {
    entry = { enabled: true, apiKey: secretRef(p.env[0].name) };
  } else if (via === 'env') {
    const env: Record<string, string> = {};
    for (const i of storeInputs(providerId, secret)) env[i.name] = i.value;
    entry = { enabled: true, env };
  }
  return { skills: { entries: { [name]: entry } } };
}

/** The merge patch that removes the skill entry (null deletes the key). */
export function disablePatch(providerId: string): object | null {
  const p = nativeProvider(providerId);
  if (!p?.skill) return null;
  return { skills: { entries: { [p.skill.name]: null } } };
}

// ── plans ───────────────────────────────────────────────────────────────────────────

export type PlanStep =
  | { kind: 'store-set'; argv: string[] }
  | { kind: 'store-rm'; argv: string[] }
  | { kind: 'config-patch'; argv: string[] }
  | { kind: 'reload'; argv: string[] };

/** The commands an enable runs, in order. Carries no values. Same input, same plan. */
export function enablePlan(providerId: string): PlanStep[] {
  const p = nativeProvider(providerId);
  if (!p) throw new Error(`No native delivery for provider: ${providerId}`);
  const steps: PlanStep[] = p.env.map((e) => ({ kind: 'store-set', argv: storeSetArgv(e.name) }));
  if (p.skill) steps.push({ kind: 'config-patch', argv: [...CONFIG_PATCH_ARGV] });
  steps.push({ kind: 'reload', argv: [...SECRETS_RELOAD_ARGV] });
  return steps;
}

/** The commands a disable runs, in order. */
export function disablePlan(providerId: string): PlanStep[] {
  const p = nativeProvider(providerId);
  if (!p) throw new Error(`No native delivery for provider: ${providerId}`);
  const steps: PlanStep[] = p.env.map((e) => ({ kind: 'store-rm', argv: storeRemoveArgv(e.name) }));
  if (p.skill) steps.push({ kind: 'config-patch', argv: [...CONFIG_PATCH_ARGV] });
  steps.push({ kind: 'reload', argv: [...SECRETS_RELOAD_ARGV] });
  return steps;
}


/** True when `version` (e.g. `2026.9.3`) is at least `min` (default {@link NATIVE_MIN_VERSION}). */
export function supportsNative(version: string | null | undefined, min = NATIVE_MIN_VERSION): boolean {
  const m = /(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(version ?? '');
  if (!m) return false;
  const a = [Number(m[1]), Number(m[2]), Number(m[3])];
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}


/**
 * Whether a native removal has to run for an assignment row. A superseded sibling (another
 * profile of the same provider took its place) is neither enabled nor pending: the
 * environment names are shared, so removing them would wipe the active credential.
 */
export const needsNativeRemoval = (a: { enabled: boolean; pendingRemoval: boolean } | null | undefined): boolean =>
  !!a && (a.enabled || a.pendingRemoval);

// ── redaction ───────────────────────────────────────────────────────────────────────

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const jsonEscaped = (v: string): string => JSON.stringify(v).slice(1, -1);

/**
 * Remove secret values from a text that is stored or shown. Each value is matched as
 * given, trimmed, and in its JSON-escaped form (a token holding a quote or a backslash
 * appears escaped in a stdin patch echoed back by an error). A form of 4 or more
 * characters is removed wherever it occurs; a shorter one only as a whole token (no
 * letter or digit on either side), so a short value never mangles ordinary words.
 */
export function redact(message: string, values: readonly string[]): string {
  const forms = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    for (const f of [v, v.trim(), jsonEscaped(v), jsonEscaped(v.trim())]) if (f) forms.add(f);
  }
  let out = message;
  for (const f of [...forms].sort((a, b) => b.length - a.length)) {
    out = f.length >= 4
      ? out.split(f).join('***')
      : out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(f)}(?![A-Za-z0-9])`, 'g'), '***');
  }
  return out;
}

// ── execution, with the exec primitives injected ───────────────────────────────────────

/** The two ways to run a command inside an agent. delivery.ts binds them to docker exec. */
export interface NativeExec {
  /** `opts.timeoutMs` overrides the default deadline (the mongosh install takes minutes). */
  run(argv: string[], env?: Record<string, string>, opts?: { timeoutMs?: number }): Promise<string>;
  runWithInput(argv: string[], input: string): Promise<string>;
}

/**
 * Refuse, before anything is written, when the agent runs an OpenClaw older than the
 * provider needs. Every provider goes through this, including the two that are delivered
 * by managed.ts (GitHub, Vercel) rather than by {@link runEnable}.
 */
export async function assertDeliverable(exec: NativeExec, providerId: string): Promise<void> {
  const version = await agentVersion(exec);
  const min = nativeProvider(providerId)?.minVersion ?? NATIVE_MIN_VERSION;
  if (!supportsNative(version, min)) {
    throw new UnsupportedNativeVersionError(
      `Native credential delivery needs OpenClaw ${min} or newer; this agent runs ${version ?? 'an unknown version'}. Update the agent first.`,
    );
  }
}

async function agentVersion(exec: NativeExec): Promise<string | null> {
  return /(\d{4}\.\d{1,2}\.\d{1,2})/.exec(await exec.run([...VERSION_ARGV]))?.[1] ?? null;
}

/** Write the store entries and the skill config, then reload. Throws a message free of secret values. */
export async function runEnable(exec: NativeExec, providerId: string, secret: Record<string, string>): Promise<void> {
  const values = Object.values(secret).map((v) => v ?? '');
  try {
    await assertDeliverable(exec, providerId);
    for (const input of storeInputs(providerId, secret)) {
      await exec.runWithInput(storeSetArgv(input.name), input.value); // name in argv, value on stdin
    }
    const patch = enablePatch(providerId, secret);
    if (patch) await exec.runWithInput([...CONFIG_PATCH_ARGV], JSON.stringify(patch));
    await exec.run(secretsReloadExecArgv(), { ...SECRETS_RELOAD_ENV });
  } catch (e) {
    if (e instanceof UnsupportedNativeVersionError) throw e;
    throw new Error(redact((e as Error).message, values));
  }
}

/**
 * Remove the store entries and the skill entry, then reload. EVERY step is attempted even
 * when one fails, so a single failure never leaves the rest of the token behind. Returns the
 * failures (empty = fully removed); rm exits 0 on a missing name, so any failure is real.
 */
export async function runDisable(exec: NativeExec, providerId: string, secretValues: readonly string[] = []): Promise<string[]> {
  const p = nativeProvider(providerId);
  if (!p) return [];
  const errors: string[] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    try { await fn(); } catch (e) { errors.push(redact(`${what}: ${(e as Error).message}`, secretValues)); }
  };
  for (const e of p.env) await attempt(`remove ${e.name}`, () => exec.run(storeRemoveArgv(e.name)));
  const patch = disablePatch(providerId);
  if (patch) await attempt('remove the skill entry', () => exec.runWithInput([...CONFIG_PATCH_ARGV], JSON.stringify(patch)));
  await attempt('reload', () => exec.run(secretsReloadExecArgv(), { ...SECRETS_RELOAD_ENV }));
  return errors;
}

export const CODEX_NOTE =
  'This agent runs on the ChatGPT subscription runtime: the token reaches only commands run through OpenClaw.';
