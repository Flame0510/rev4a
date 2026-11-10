/**
 * Provider-specific delivery for the two credentials an environment entry cannot
 * carry. Everything else goes through the OpenClaw secret store (see native.ts);
 * these two cannot, for reasons that live in OpenClaw and the Vercel CLI.
 *
 * - GitHub. `GH_TOKEN` and `GITHUB_TOKEN` are in OpenClaw's `host-env-security`
 *   override-blocked list (`blockedOverrideOnlyKeys`), so a secret-store `env`
 *   entry with either name is dropped before any command runs (`rejectedOverride
 *   BlockedKeys`) and `gh` stays logged out. GitHub identity must go through the
 *   managed profile: a one-use `github-setup-<32hex>` handoff written to the
 *   secret store, then `tools.github.configure` with `mode: "managed"`. OpenClaw
 *   validates the PAT against GitHub, writes a private `gh` profile under its own
 *   credentials directory and keeps only `tools.github.profileId` in config.
 * - Vercel. The CLI resolves its scope from the account's default team and, for a
 *   `northstar` account, forces it even when `config.json` names another team, so
 *   a `VERCEL_TOKEN`-only environment inherits a default team the token may not
 *   reach and every command fails ("... under scope <team>"). The CLI's own files
 *   (`auth.json` + `config.json` with `currentTeam`) are the delivery that works.
 *
 * GitHub RPC bodies travel on stdin to the public Gateway SDK: the PAT never enters
 * argv, the environment or script text. Older OpenClaw without that SDK uses a logged
 * compatibility fallback to `gateway call --params`, exposing the PAT in container
 * argv during that call only (visible to host users). It still arrives on stdin, never
 * in an environment variable. Vercel's file bodies travel through `docker exec -e NAME`.
 * Every JSON body is built here with `JSON.stringify`; logs redact secret values.
 * Redaction and the secret-store `rm` argv are the ones native.ts uses.
 */

import { randomBytes } from 'crypto';
import { gatewayShellScript } from '../gateway-cli';
import { redact, storeRemoveArgv, type NativeExec } from './native';

/** The single OpenClaw agent inside a Rev4a container. */
export const OPENCLAW_AGENT_ID = 'main';

const HANDOFF_RE = /^github-setup-[a-f0-9]{32}$/;

function handoffRmArgv(name: string): string[] {
  if (!HANDOFF_RE.test(name)) throw new Error('Invalid handoff name');
  return ['openclaw', 'secrets', 'store', 'rm', '--yes', name];
}

/** The agent's Gateway listens on 3000, not OpenClaw's default. */
const GATEWAY_URL = 'ws://127.0.0.1:3000';

const VERCEL_DIR = '/root/.local/share/com.vercel.cli';

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

// ── GitHub: managed identity via the Gateway RPCs ──────────────────────────

/** One `github-setup-<32 lowercase hex>` handoff name, as OpenClaw's schema requires. */
export function githubHandoffName(): string {
  return `github-setup-${randomBytes(16).toString('hex')}`;
}

export function githubStoreParams(name: string, token: string): string {
  return JSON.stringify({ name, value: token, kind: 'secret', allowedHosts: [] });
}

export function githubConfigureParams(name: string): string {
  return JSON.stringify({ scope: 'agent', agentId: OPENCLAW_AGENT_ID, mode: 'managed', secretName: name });
}

export function githubInheritParams(): string {
  return JSON.stringify({ scope: 'agent', agentId: OPENCLAW_AGENT_ID, mode: 'inherit' });
}

/**
 * Only our import probe emits the marker, and it is a fresh random nonce per call sent on stdin:
 * no output of OpenClaw can contain it by chance, so neither SDK chatter nor an RPC answer can
 * select or hide the fallback.
 */
const GITHUB_RPC_SCRIPT = `
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const { method, params, marker } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
let callGatewayFromCli;
try {
  ({ callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime'));
} catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e;
}
if (typeof callGatewayFromCli !== 'function') {
  process.stdout.write(marker);
} else {
  try {
    await callGatewayFromCli(method, { url: process.env.OPENCLAW_GATEWAY_URL,
      token: process.env.OPENCLAW_GATEWAY_TOKEN, timeout: '15000', json: true }, params);
  } catch (e) {
    // The message only, like \`openclaw gateway call\`: never a stack trace. Any secret value of
    // the params is masked here, before the text leaves the container (the host redacts again).
    let msg = String(e && e.message ? e.message : e);
    if (params && typeof params.value === 'string' && params.value) msg = msg.split(params.value).join('***');
    process.stderr.write('Gateway call failed: ' + msg);
    // exitCode, not exit(): the process ends after stderr is flushed, so the text is never cut.
    process.exitCode = 1;
  }
}
`;

/** Legacy CLI has no stdin params option. Only this fallback puts the PAT in container argv. */
const GITHUB_LEGACY_RPC_SCRIPT = `
import { spawnSync } from 'node:child_process';
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const { method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const result = spawnSync('openclaw', ['gateway', 'call', method, '--params', JSON.stringify(params)],
  { stdio: ['ignore', 'ignore', 'inherit'] });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;

function githubRpcArgv(script: string): string[] {
  return ['sh', '-c', gatewayShellScript([
    `export OPENCLAW_GATEWAY_URL=${GATEWAY_URL}`,
    'cd "$(dirname "$(readlink -f "$(command -v openclaw)")")" && exec node --input-type=module -e "$1"',
  ].join('; ')), 'sh', script];
}

/** Share one transport for both enable RPCs, logging the legacy fallback once per enable. */
function githubRpc(exec: NativeExec): (method: string, params: string) => Promise<void> {
  let legacy = false;
  return async (method, params) => {
    const marker = `REV4A_GITHUB_SDK_UNAVAILABLE_${randomBytes(16).toString('hex')}`;
    const input = JSON.stringify({ method, params: JSON.parse(params), marker });
    if (!legacy) {
      const output = await exec.runWithInput(githubRpcArgv(GITHUB_RPC_SCRIPT), input);
      if (!output.includes(marker)) return;
      legacy = true;
      console.warn('[credentials] GitHub Gateway SDK unavailable; using legacy argv fallback (PAT visible in container process argv during delivery).');
    }
    await exec.runWithInput(githubRpcArgv(GITHUB_LEGACY_RPC_SCRIPT), input);
  };
}

/** Place the handoff and bind the managed identity. Throws a message free of the token. */
export async function githubEnable(exec: NativeExec, token: string): Promise<void> {
  const name = githubHandoffName();
  const call = githubRpc(exec);
  try {
    await call('secrets.store.set', githubStoreParams(name, token));
    await call('tools.github.configure', githubConfigureParams(name));
  } catch (e) {
    // The handoff holds the token and is only consumed by a successful configure: do not leave it behind.
    try { await exec.run(handoffRmArgv(name)); } catch { /* the enable error below is the one to report */ }
    throw new Error(redact((e as Error).message, [token]));
  }
}

/**
 * Remove any `github-setup-<hex>` handoff left in the secret store (a failed enable, or one
 * that was interrupted). Best effort: it lists the store, keeps only names of exactly that
 * shape, and never fails the caller.
 */
async function sweepGithubHandoffs(exec: NativeExec): Promise<void> {
  const script = [
    "openclaw secrets store list 2>/dev/null | grep -o 'github-setup-[a-f0-9]\\{32\\}' | sort -u |",
    'while read -r n; do openclaw secrets store rm --yes "$n" >/dev/null 2>&1; done; exit 0',
  ].join(' ');
  try { await exec.run(['sh', '-c', gatewayShellScript(script)]); } catch { /* best effort */ }
}

/** Drop the managed override (the agent falls back to native/absent GitHub identity). */
export async function githubDisable(exec: NativeExec): Promise<void> {
  const script = 'openclaw gateway call tools.github.configure --params "$REV4A_CONF_PARAMS" >/dev/null';
  try {
    await exec.run(['sh', '-c', gatewayShellScript(script)], {
      OPENCLAW_GATEWAY_URL: GATEWAY_URL,
      REV4A_CONF_PARAMS: githubInheritParams(),
    });
  } finally {
    await sweepGithubHandoffs(exec);
  }
}

// ── Vercel: the CLI's own auth.json + config.json{currentTeam} ─────────────

/**
 * The team to pin as `currentTeam`: the account's default when the token can reach
 * it, otherwise the first accessible team (a personal account usually has none).
 * Named exactly as the previous release did — it is what kept the scope error
 * away when the account default was a team the token could not use.
 */
export async function discoverVercelTeam(token: string): Promise<string | null> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const userRes = await fetch('https://api.vercel.com/v2/user', { headers, signal: AbortSignal.timeout(10000) });
  if (!userRes.ok) throw new Error(`Vercel API returned ${userRes.status} for /v2/user`);
  const body = (await userRes.json()) as { user?: { id?: string; defaultTeamId?: string } };
  const user = body.user;
  if (!user?.id) throw new Error('Invalid token response from Vercel API');

  try {
    const teamsRes = await fetch('https://api.vercel.com/v2/teams', { headers, signal: AbortSignal.timeout(10000) });
    if (!teamsRes.ok) return null;
    const teams = ((await teamsRes.json()) as { teams?: { id: string }[] }).teams ?? [];
    if (!teams.length) return null;
    const preferred = user.defaultTeamId ? teams.find((t) => t.id === user.defaultTeamId) : undefined;
    return (preferred ?? teams[0]).id;
  } catch {
    return null;
  }
}

/**
 * The CLI's `config.json`: `currentTeam` only when a team was found. It is always written, so
 * a `currentTeam` left by an earlier delivery (a team the token can no longer reach) never
 * survives into a delivery that found none.
 */
export function vercelConfig(team: string | null): Record<string, string> {
  return team ? { currentTeam: team } : {};
}

export async function vercelEnable(exec: NativeExec, token: string, team: string | null): Promise<void> {
  const script = [
    `umask 077 && mkdir -p ${VERCEL_DIR}`,
    `printf '%s' "$REV4A_VERCEL_AUTH" | base64 -d > ${VERCEL_DIR}/auth.json`,
    `printf '%s' "$REV4A_VERCEL_CONF" | base64 -d > ${VERCEL_DIR}/config.json`,
    `chmod 600 ${VERCEL_DIR}/auth.json ${VERCEL_DIR}/config.json`,
  ].join(' && ');
  const env: Record<string, string> = {
    REV4A_VERCEL_AUTH: b64(JSON.stringify({ token })),
    REV4A_VERCEL_CONF: b64(JSON.stringify(vercelConfig(team))),
  };
  try {
    await exec.run(['sh', '-c', script], env);
  } catch (e) {
    throw new Error(redact((e as Error).message, [token]));
  }
}

export async function vercelDisable(exec: NativeExec): Promise<void> {
  await exec.run(['sh', '-c', `rm -rf ${VERCEL_DIR}; exit 0`]);
}

// ── Store entries left behind by an earlier native delivery ────────────────

/**
 * Remove secret-store `env` entries that an earlier release wrote for a provider
 * whose environment names OpenClaw drops or the CLI ignores (GH_TOKEN,
 * GITHUB_TOKEN, VERCEL_TOKEN). `rm` exits 0 on a missing name, so a failure is real.
 */
export async function removeStoreEntries(exec: NativeExec, names: readonly string[]): Promise<void> {
  for (const name of names) await exec.run(storeRemoveArgv(name));
}
