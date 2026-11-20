/**
 * channelManager.ts
 *
 * Reads and writes channel configuration (Telegram) directly
 * inside agent containers via `docker exec`.
 *
 * ── How it works ──
 *
 * Telegram:
 *   - Fully config-file driven. Token is written to
 *     channels.telegram.botToken in /root/.openclaw/openclaw.json.
 *   - No interactive login needed. Gateway picks it up on next restart.
 *
 * File layout inside agent container:
 *   /root/.openclaw/openclaw.json          — config
 *
 * ── Reference ──
 *
 *   OpenClaw docs:
 *     - channels/telegram.md
 *     - gateway/config-channels.md
 *     - concepts/multi-agent.md (bindings)
 */
import { execSync } from 'child_process';
import { dockerExec, dockerExecShellNoFail } from '@/lib/docker-exec';
import { gatewayCliArgv, gatewayShellScript } from '@/lib/gateway-cli';
import { withAgentConfigLock } from '@/lib/agent-config-lock';
import { PAIRING_STORE_SCRIPT, parsePairingStoreOutput, type PairingStoreResult } from '@/lib/channel-pairing-store';

// ── Types ────────────────────────────────────

export interface TelegramChannel {
  connected: boolean;
  botToken: string; // masked
  dmPolicy: string;
  allowFrom: string[];
}

export interface AgentChannels {
  agentId: string;
  telegram: TelegramChannel | null;
}

// ── Helpers ──────────────────────────────────

function containerExec(containerName: string, cmd: string): string {
  return execSync(
    `docker exec ${escapeShellArg(containerName)} sh -c ${escapeShellArg(cmd)}`,
    { encoding: 'utf-8', timeout: 15000, maxBuffer: 1024 * 1024 * 5 },
  ).trim();
}

function containerExecNoFail(containerName: string, cmd: string): string {
  try { return containerExec(containerName, cmd); } catch { return ''; }
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function readConfigJson(containerName: string): Record<string, unknown> | null {
  try {
    const raw = containerExecNoFail(containerName, 'cat /root/.openclaw/openclaw.json 2>/dev/null');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeConfigJson(containerName: string, config: Record<string, unknown>): void {
  const json = JSON.stringify(config, null, 2);
  if (!json || json === 'null') {
    throw new Error('Refusing to write empty or invalid config');
  }
  // Pipe JSON via stdin to avoid shell escaping issues
  execSync(
    `docker exec -i ${escapeShellArg(containerName)} sh -c 'cat > /root/.openclaw/openclaw.json.tmp && mv /root/.openclaw/openclaw.json.tmp /root/.openclaw/openclaw.json'`,
    { input: json, encoding: 'utf-8', timeout: 15000 },
  );
}

function maskToken(token: string): string {
  if (!token || token.length <= 8) return token ? token.slice(0, 4) + '...' : '';
  return token.slice(0, 4) + '...' + token.slice(-4);
}

function findContainerById(agentId: string): string | null {
  // Sanitize: only allow alphanumeric, hyphens, and underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) return null;
  try {
    const out = execSync(
      `docker ps --filter "label=AGENT_ID=${agentId}" --format "{{.Names}}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────

/**
 * Read the Telegram channel out of an already-parsed openclaw.json.
 *
 * Pure — no container access — so callers that have obtained the config some
 * other way (in bulk, asynchronously) can share the same interpretation instead
 * of reimplementing it.
 */
export function parseTelegramChannel(config: Record<string, unknown>): TelegramChannel | null {
  const telegram = (config.channels as Record<string, unknown>)?.telegram as Record<string, unknown> | undefined;
  if (!telegram || telegram.enabled === false) return null;

  const botToken = (telegram.botToken ?? '') as string;
  if (typeof botToken !== 'string' || botToken.length === 0) return null;

  return {
    connected: true,
    botToken: maskToken(botToken),
    dmPolicy: (telegram.dmPolicy ?? 'pairing') as string,
    allowFrom: (Array.isArray(telegram.allowFrom) ? telegram.allowFrom : []) as string[],
  };
}

export function getChannels(agentId: string): AgentChannels {
  const container = findContainerById(agentId);
  const result: AgentChannels = { agentId, telegram: null };

  if (!container) return result;

  const config = readConfigJson(container);
  if (!config) return result;

  result.telegram = parseTelegramChannel(config);
  return result;
}

// ── Telegram ─────────────────────────────────

export async function setTelegramConfig(
  agentId: string,
  params: {
    botToken: string;
    dmPolicy?: string;
    allowFrom?: string[];
  },
): Promise<{ success: boolean; error?: string }> {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
    // Read and write inside one lock: another writer on this agent between them would be lost.
    return await withAgentConfigLock(container, async () => {
    // A failed read is not an empty config: writing `{}` back would replace the agent's
    // whole openclaw.json with the channel block (the historical defect this route had).
    const config = readConfigJson(container);
    if (!config) return { success: false, error: 'Could not read the agent configuration' };

    // Ensure channels.telegram structure
    if (!config.channels) config.channels = {};
    const channels = config.channels as Record<string, unknown>;
    const existing = (channels.telegram as Record<string, unknown> | undefined) ?? {};

    // Preserve existing allowFrom if not explicitly overridden
    const existingAllowFrom = params.allowFrom?.length
      ? params.allowFrom
      : (existing.allowFrom as string[] | undefined);

    // If token changed, wipe old pairing data to avoid orphaned allowFrom entries
    const oldToken = existing.botToken as string | undefined;
    if (oldToken && oldToken !== params.botToken && (existing.dmPolicy as string) === 'pairing') {
      await clearChannelAllowlist(container, 'telegram');
    }

    // Merge channel config: preserve ALL existing keys (provider, etc.)
    // and only overwrite the specific fields we're setting.
    channels.telegram = {
      ...existing,
      enabled: true,
      botToken: params.botToken,
      dmPolicy: params.dmPolicy ?? existing.dmPolicy ?? 'pairing',
    };

    if (existingAllowFrom && existingAllowFrom.length > 0) {
      (channels.telegram as Record<string, unknown>).allowFrom = existingAllowFrom;
    }

    // Ensure a binding exists for this agent → telegram
    ensureBinding(config, agentId, 'telegram', undefined);

    writeConfigJson(container, config);
    return { success: true };
    });
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function removeTelegram(agentId: string): Promise<{ success: boolean; error?: string }> {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
    return await withAgentConfigLock(container, async () => {
    const config = readConfigJson(container);
    if (!config) return { success: false, error: 'No config found' };

    const channels = config.channels as Record<string, unknown> | undefined;
    if (channels) {
      // Disable telegram and clear pairing data
      const tg = channels.telegram as Record<string, unknown> | undefined;
      if (tg) {
        tg.enabled = false;
        // Wipe allowFrom and botToken so reconnecting with a different bot starts fresh
        delete tg.botToken;
        delete tg.allowFrom;
      }
    }

    // The approved senders belong to the disconnected bot: clear the pairing store.
    await clearChannelAllowlist(container, 'telegram');

    removeBindings(config, agentId, 'telegram');
    writeConfigJson(container, config);
    return { success: true };
    });
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// ── Internal helpers ─────────────────────────

/**
 * Ensure a binding exists for channel → "main" agent.
 *
 * The agentId in the binding MUST be "main" (OpenClaw's default agent)
 * so that sessions are created as `agent:main:main`.
 * Using the container name as agentId would create sessions like
 * `agent:<AGENT_NAME>:main` which breaks model bindings that target
 * `agent:main:*`.
 *
 * Per multi-agent.md: bindings route (channel, accountId) to agentId.
 * For mono-account, accountId defaults to "default".
 */
function ensureBinding(
  config: Record<string, unknown>,
  _agentId: string, // kept for API compatibility, ignored — we always bind to "main"
  channel: string,
  accountId: string | undefined,
): void {
  const bindingAgentId = 'main'; // always bind to the default agent
  const effectiveAccountId = accountId ?? 'default';
  const bindings = (Array.isArray(config.bindings) ? config.bindings : []) as Record<string, unknown>[];

  const exists = bindings.some(
    (b) =>
      b.agentId === bindingAgentId &&
      (b.match as Record<string, unknown>)?.channel === channel &&
      ((b.match as Record<string, unknown>)?.accountId ?? 'default') === effectiveAccountId,
  );

  if (!exists) {
    bindings.push({
      agentId: bindingAgentId,
      match: {
        channel,
        accountId: effectiveAccountId,
      },
    });
    config.bindings = bindings;
  }
}

function removeBindings(config: Record<string, unknown>, _agentId: string, channel: string): void {
  const bindingAgentId = 'main';
  const bindings = (Array.isArray(config.bindings) ? config.bindings : []) as Record<string, unknown>[];
  config.bindings = bindings.filter(
    (b) => !(b.agentId === bindingAgentId && (b.match as Record<string, unknown>)?.channel === channel),
  );
}

// ── Pairing ──────────────────────────────────

export interface PendingPairing {
  code: string;
  senderId: string | null;
}

export interface ApprovedPairing {
  senderId: string;
}

export interface PairingState {
  pending: PendingPairing[];
  approved: ApprovedPairing[];
  /**
   * An unreadable pending or approved list is distinct from a valid empty list.
   * Other successfully read results remain available alongside this error.
   */
  error?: string | null;
}

/** Channel ids reach shell commands and the store API; keep them to OpenClaw's shape. */
function isSafeChannel(channel: string): boolean {
  return /^[a-z0-9_-]+$/.test(channel);
}

/** Public async read/legacy fallback; private removal stays isolated in the tested script. */
async function runPairingStore(container: string, op: 'read' | 'remove' | 'clear', channel: string, entry?: string): Promise<PairingStoreResult> {
  const argv = ['node', '-e', PAIRING_STORE_SCRIPT, op, channel];
  if (entry !== undefined) argv.push(entry);
  try {
    // Arguments stay positional. The async SDK import must not block the server.
    const out = await dockerExec(container, argv, { timeoutMs: 20_000 });
    return parsePairingStoreOutput(out, op);
  } catch {
    // Do not return native command/stderr text: it may include configuration or secrets.
    return { status: 'error', error: 'Pairing store command failed or timed out' };
  }
}

/** Drop every approved sender of a channel — a different bot must not inherit them. */
async function clearChannelAllowlist(container: string, channel: string): Promise<void> {
  if (!isSafeChannel(channel)) throw new Error('Invalid channel id');
  const result = await runPairingStore(container, 'clear', channel);
  if (result.status !== 'ok') {
    throw new Error(result.error ?? 'This OpenClaw release does not expose the capability to clear approved senders');
  }
}

/** Get pending + approved pairings for a channel */
export async function getPairings(agentId: string, channel: string = 'telegram'): Promise<PairingState> {
  const container = findContainerById(agentId);
  const fallback: PairingState = { pending: [], approved: [] };
  if (!container || !isSafeChannel(channel)) return fallback;

  // A failed/malformed pending list must not look like a successful empty read.
  const pending: PendingPairing[] = [];
  let pendingError: string | null = null;
  try {
    const raw = await dockerExec(container, gatewayCliArgv(['pairing', 'list', '--channel', channel, '--json']), { timeoutMs: 20_000 });
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { requests?: unknown }).requests)) {
      throw new Error('Invalid pending list');
    }
    const rows = (parsed as { requests: unknown[] }).requests.map((req): PendingPairing => {
      if (!req || typeof req !== 'object') throw new Error('Invalid pending request');
      const row = req as { code?: unknown; id?: unknown; senderId?: unknown };
      const code = row.code ?? row.id;
      if (typeof code !== 'string' || !code || (row.senderId != null && typeof row.senderId !== 'string')) {
        throw new Error('Invalid pending request fields');
      }
      return { code, senderId: row.senderId ?? null };
    });
    pending.push(...rows);
  } catch {
    pendingError = 'The pending pairing requests could not be read';
  }

  // Approved: OpenClaw's pairing store (2026.9.x keeps it in SQLite).
  const approved: ApprovedPairing[] = [];
  const store = await runPairingStore(container, 'read', channel);
  if (store.status === 'ok') {
    for (const entry of store.entries ?? []) approved.push({ senderId: entry });
  }
  // 'absent' is a real answer (no store yet, so no approved senders); anything else means
  // the read did not succeed and an empty list must not be presented as "none".
  const approvedError = store.status === 'ok' || store.status === 'absent'
    ? null
    : (store.error ?? 'The approved senders could not be read');
  const error = [pendingError, approvedError].filter(Boolean).join('; ') || null;

  return { pending, approved, error };
}

/** Approve a pending pairing code */
export async function approvePairing(agentId: string, code: string, channel: string = 'telegram'): Promise<{ success: boolean; error?: string }> {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };
  if (!isSafeChannel(channel)) return { success: false, error: 'Invalid channel id' };

  try {
    const out = await dockerExecShellNoFail(container, gatewayShellScript(
      `export OPENCLAW_GATEWAY_PORT=3000; openclaw pairing approve ${channel} ${escapeShellArg(code)} 2>&1`,
    ));
    if (!out) {
      return { success: false, error: 'Command produced no output — pairing command may not be available' };
    }
    if (out.includes('error')) {
      return { success: false, error: out };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Revoke an approved sender from the allowlist.
 *
 * There is no CLI or RPC for this: `openclaw pairing` exposes only `approve`, `list`
 * and `help`, and `channels.pairing.*` has no remove (verified on 2026.9.3). The
 * store's own writer is called instead (`removeChannelAllowFromStoreEntry`, found by
 * name — see PAIRING_STORE_SCRIPT). On a release that no longer exposes it, the
 * failure is explicit: nothing is silently left unchanged (which is what the old
 * `openclaw pairing revoke` probe did).
 */
export async function revokePairing(agentId: string, senderId: string, channel: string = 'telegram'): Promise<{ success: boolean; error?: string }> {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };
  if (!isSafeChannel(channel)) return { success: false, error: 'Invalid channel id' };

  const result = await runPairingStore(container, 'remove', channel, senderId);
  if (result.status === 'ok') return { success: true };
  if (result.status === 'absent') return { success: true }; // already gone — the desired state
  if (result.status === 'unsupported') {
    return {
      success: false,
      error: 'This OpenClaw release does not expose its pairing store to Rev4a. '
           + 'Revoke the sender with `/allowlist remove` from the chat.',
    };
  }
  return { success: false, error: result.error ?? 'Revoke failed' };
}
