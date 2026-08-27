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
 * `agent:NOMEAGENTE:main` which breaks model bindings that target
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

/** Revoke an approved sender from the allowlist */
export function revokePairing(agentId: string, senderId: string, channel: string = 'telegram'): { success: boolean; error?: string } {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
    // Try native revoke command first, fall back to direct file manipulation
    const nativeOut = containerExecNoFail(
      container,
      `openclaw pairing revoke ${channel} ${escapeShellArg(senderId)} 2>&1`,
    );

    if (nativeOut && !nativeOut.includes('Unknown command') && !nativeOut.includes('not found')) {
      return { success: true };
    }

    // Fallback: remove from credentials file directly
    const filePath = pairingAllowFile(channel);
    const fallbackOut = containerExecNoFail(
      container,
      `node -e "const p='${filePath}';try{const d=JSON.parse(require('fs').readFileSync(p,'utf8'));d.allowFrom=(d.allowFrom||[]).filter(e=>e!=='${senderId.replace(/'/g, "'\\''")}');require('fs').writeFileSync(p,JSON.stringify(d,null,2),'utf8')}catch(e){console.error('revoke fallback error:',e.message)}"`,
    );
    if (fallbackOut && fallbackOut.includes('revoke fallback error:')) {
      return { success: false, error: fallbackOut };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
