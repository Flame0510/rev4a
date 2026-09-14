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
import { execSync, execFileSync } from 'child_process';

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

export function setTelegramConfig(
  agentId: string,
  params: {
    botToken: string;
    dmPolicy?: string;
    allowFrom?: string[];
  },
): { success: boolean; error?: string } {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
    const config = readConfigJson(container) ?? {};

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
      containerExecNoFail(
        container,
        `rm -f ${pairingFiles('telegram')} 2>/dev/null`,
      );
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
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export function removeTelegram(agentId: string): { success: boolean; error?: string } {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
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

    // Clean up pairing files — they belong to the disconnected bot
    containerExecNoFail(
      container,
      `rm -f ${pairingFiles('telegram')} 2>/dev/null`,
    );

    removeBindings(config, agentId, 'telegram');
    writeConfigJson(container, config);
    return { success: true };
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
}

function pairingAllowFile(channel: string): string {
  return `/root/.openclaw/credentials/${channel}-default-allowFrom.json`;
}

function pairingFiles(channel: string): string {
  return `/root/.openclaw/credentials/${channel}-pairing.json /root/.openclaw/credentials/${channel}-default-allowFrom.json`;
}

/** Get pending + approved pairings for a channel */
export function getPairings(agentId: string, channel: string = 'telegram'): PairingState {
  const container = findContainerById(agentId);
  const fallback: PairingState = { pending: [], approved: [] };
  if (!container) return fallback;

  // Pending
  const pendingRaw = containerExecNoFail(container, `openclaw pairing list --channel ${channel} --json 2>/dev/null`);
  const pending: PendingPairing[] = [];
  if (pendingRaw) {
    try {
      const parsed = JSON.parse(pendingRaw);
      for (const req of parsed.requests ?? []) {
        pending.push({
          code: req.code ?? req.id ?? '',
          senderId: req.senderId ?? null,
        });
      }
    } catch { /* ignore */ }
  }

  // Approved: read from OpenClaw credentials file
  const allowRaw = containerExecNoFail(container, `cat ${pairingAllowFile(channel)} 2>/dev/null`);
  const approved: ApprovedPairing[] = [];
  if (allowRaw) {
    try {
      const parsed = JSON.parse(allowRaw);
      const entries = parsed?.allowFrom ?? [];
      for (const entry of entries) {
        if (typeof entry === 'string') {
          approved.push({ senderId: entry });
        } else if (entry?.senderId || entry?.id) {
          approved.push({ senderId: entry.senderId ?? entry.id });
        }
      }
    } catch { /* ignore */ }
  }

  return { pending, approved };
}

/** Approve a pending pairing code */
export function approvePairing(agentId: string, code: string, channel: string = 'telegram'): { success: boolean; error?: string } {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
    const out = containerExecNoFail(container, `openclaw pairing approve ${channel} ${escapeShellArg(code)} 2>&1`);
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
 * Script run inside the container to drop one sender from the allowlist file.
 *
 * The sender id arrives as `process.argv[1]`, never interpolated into the source.
 * The previous version built this string by substitution, applying shell-style
 * escaping to a value that lands inside a JavaScript string literal: an id
 * containing an apostrophe closed the literal and the rest ran as code.
 *
 * It prints one of three sentinels so the caller can tell the outcomes apart —
 * `docker exec` exits 0 even when killed by the timeout, so an empty result
 * cannot be read as success (see docs/ARCHITECTURE.md §3.1).
 */
const REVOKE_SCRIPT = `
const fs = require('fs');
const [p, target] = [process.argv[1], process.argv[2]];
try {
  if (!fs.existsSync(p)) { console.log('revoke:no-store'); process.exit(0); }
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const before = (d.allowFrom || []).length;
  d.allowFrom = (d.allowFrom || []).filter((e) => String(e) !== target);
  if (d.allowFrom.length === before) { console.log('revoke:absent'); process.exit(0); }
  fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
  console.log('revoke:ok');
} catch (e) {
  console.log('revoke:error ' + e.message);
}
`;

/**
 * Revoke an approved sender from the allowlist.
 *
 * There is no CLI for this. `openclaw pairing` exposes only `approve`, `list` and
 * `help` — verified on both 2026.7.1-2 and 2026.9.3 — so the allowlist store has
 * to be edited directly.
 *
 * The previous implementation tried `openclaw pairing revoke` first and treated
 * any output that lacked "Unknown command" or "not found" as success. OpenClaw
 * actually answers `OpenClaw does not know the command "revoke".`, which contains
 * neither, so every revocation reported success, changed nothing, and never
 * reached the fallback.
 *
 * On 2026.9.x this store moved into SQLite and the file is gone. Rather than
 * silently doing nothing again, that case now fails loudly. Revocation against 9.x's SQLite store is not
 * implemented yet.
 */
export function revokePairing(agentId: string, senderId: string, channel: string = 'telegram'): { success: boolean; error?: string } {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
    // execFileSync, not a shell: argv is passed through untouched, so nothing in
    // `senderId` can be read as syntax.
    const out = execFileSync(
      'docker',
      ['exec', container, 'node', '-e', REVOKE_SCRIPT, pairingAllowFile(channel), senderId],
      { encoding: 'utf-8', timeout: 15000, maxBuffer: 1024 * 1024 },
    ).trim();

    if (out.includes('revoke:ok')) return { success: true };
    if (out.includes('revoke:absent')) return { success: true }; // already gone — the desired state
    if (out.includes('revoke:no-store')) {
      return {
        success: false,
        error: 'No allowlist file in this container: nobody has been approved on this '
             + 'channel yet, or the agent runs OpenClaw 9.x, whose pairing store is in '
             + 'SQLite and cannot be revoked from here yet.',
      };
    }
    return { success: false, error: out || 'revoke produced no output' };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
