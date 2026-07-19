/**
 * channelManager.ts
 *
 * Reads and writes channel configuration (Telegram, WhatsApp) directly
 * inside agent containers via `docker exec`.
 *
 * ── How it works ──
 *
 * Telegram:
 *   - Fully config-file driven. Token is written to
 *     channels.telegram.botToken in /root/.openclaw/openclaw.json.
 *   - No interactive login needed. Gateway picks it up on next restart.
 *
 * WhatsApp:
 *   - Config is set via config file (channels.whatsapp.dmPolicy etc.).
 *   - Linking is done interactively via `openclaw channels login --channel whatsapp`
 *     (QR code on terminal, scan with phone). We cannot automate this
 *     from a web UI — we show instructions instead.
 *   - Status is checked via `openclaw channels status --channel whatsapp --json`
 *     (requires gateway running in the container).
 *
 * File layout inside agent container:
 *   /root/.openclaw/openclaw.json          — config
 *   ~/.openclaw/credentials/whatsapp/default/creds.json — WhatsApp auth (managed by OpenClaw)
 *
 * ── Reference ──
 *
 *   OpenClaw docs:
 *     - channels/telegram.md
 *     - channels/whatsapp.md
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

export interface WhatsAppChannel {
  linked: boolean;
  dmPolicy: string;
  allowFrom: string[];
  selfChatMode: boolean;
  /** Human-readable status from `openclaw channels status` */
  status: string;
}

export interface AgentChannels {
  agentId: string;
  telegram: TelegramChannel | null;
  whatsapp: WhatsAppChannel | null;
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
  // Escape for single-quoted shell string: backslash, single quote, dollar sign
  const escaped = json
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/\$/g, '\\$');
  containerExec(containerName, `echo '${escaped}' > /root/.openclaw/openclaw.json.tmp && mv /root/.openclaw/openclaw.json.tmp /root/.openclaw/openclaw.json`);
}

function maskToken(token: string): string {
  if (!token || token.length <= 8) return token ? token.slice(0, 4) + '...' : '';
  return token.slice(0, 4) + '...' + token.slice(-4);
}

function findContainerById(agentId: string): string | null {
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

export function getChannels(agentId: string): AgentChannels {
  const container = findContainerById(agentId);
  const result: AgentChannels = { agentId, telegram: null, whatsapp: null };

  if (!container) return result;

  const config = readConfigJson(container);
  if (!config) return result;

  // ── Telegram ──
  const telegram = (config.channels as Record<string, unknown>)?.telegram as Record<string, unknown> | undefined;
  if (telegram && telegram.enabled !== false) {
    const botToken = (telegram.botToken ?? '') as string;
    const hasToken = typeof botToken === 'string' && botToken.length > 0;

    if (hasToken) {
      result.telegram = {
        connected: true,
        botToken: maskToken(botToken),
        dmPolicy: (telegram.dmPolicy ?? 'pairing') as string,
        allowFrom: (Array.isArray(telegram.allowFrom) ? telegram.allowFrom : []) as string[],
      };
    }
  }

  // ── WhatsApp ──
  const whatsapp = (config.channels as Record<string, unknown>)?.whatsapp as Record<string, unknown> | undefined;
  if (whatsapp && whatsapp.enabled !== false) {
    // Status check requires gateway running; fall back to config-only if unreachable
    let linked = false;
    let statusText = 'not linked';

    const statusRaw = containerExecNoFail(container, 'openclaw channels status --channel whatsapp --json 2>/dev/null');
    if (statusRaw) {
      try {
        const parsed = JSON.parse(statusRaw);
        linked = parsed?.linked === true || parsed?.connected === true;

        if (parsed?.configOnly) {
          statusText = parsed?.error || 'Gateway not reachable';
        } else if (!linked) {
          statusText = 'not linked';
        } else {
          statusText = 'linked';
        }
      } catch {
        statusText = 'status unavailable';
      }
    }

    result.whatsapp = {
      linked,
      dmPolicy: (whatsapp.dmPolicy ?? 'pairing') as string,
      allowFrom: (Array.isArray(whatsapp.allowFrom) ? whatsapp.allowFrom : []) as string[],
      selfChatMode: whatsapp.selfChatMode === true,
      status: statusText,
    };
  }

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

    channels.telegram = {
      enabled: true,
      botToken: params.botToken,
      dmPolicy: params.dmPolicy ?? 'pairing',
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

// ── WhatsApp ─────────────────────────────────

export function enableWhatsApp(agentId: string): {
  success: boolean;
  error?: string;
} {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
    const config = readConfigJson(container) ?? {};
    if (!config.channels) config.channels = {};
    const channels = config.channels as Record<string, unknown>;

    const existing = channels.whatsapp as Record<string, unknown> | undefined;
    channels.whatsapp = {
      ...existing,
      enabled: true,
      dmPolicy: 'pairing',
    };

    ensureBinding(config, agentId, 'whatsapp', undefined);

    writeConfigJson(container, config);
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export function disableWhatsApp(agentId: string): {
  success: boolean;
  error?: string;
} {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
    // Try logout first (requires gateway running; if not, just disable config)
    containerExecNoFail(container, 'openclaw channels logout --channel whatsapp 2>/dev/null || true');

    const config = readConfigJson(container);
    if (config) {
      const channels = config.channels as Record<string, unknown> | undefined;
      if (channels?.whatsapp) {
        (channels.whatsapp as Record<string, unknown>).enabled = false;
      }

      // Clean up pairing files — they belong to the disconnected session
      containerExecNoFail(
        container,
        `rm -f ${pairingFiles('whatsapp')} 2>/dev/null`,
      );

      removeBindings(config, agentId, 'whatsapp');
      writeConfigJson(container, config);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export function getWhatsAppStatus(agentId: string): {
  linked: boolean;
  status: string;
  gatewayOk: boolean;
} {
  const container = findContainerById(agentId);
  if (!container) return { linked: false, status: 'container not found', gatewayOk: false };

  const raw = containerExecNoFail(container, 'openclaw channels status --channel whatsapp --json 2>/dev/null');
  if (!raw) return { linked: false, status: 'command failed', gatewayOk: false };

  try {
    const parsed = JSON.parse(raw);
    const linked = parsed?.linked === true || parsed?.connected === true;
    const gatewayOk = parsed?.gatewayReachable === true;

    let status: string;
    if (parsed?.configOnly) {
      status = parsed?.error || 'Gateway not reachable (config-only mode)';
    } else if (linked) {
      status = 'linked';
    } else {
      status = 'not linked';
    }

    return { linked, status, gatewayOk };
  } catch {
    return { linked: false, status: 'status unavailable', gatewayOk: false };
  }
}

// ── Internal helpers ─────────────────────────

/**
 * Ensure a binding exists for agentId → channel.
 * Per multi-agent.md: bindings route (channel, accountId) to agentId.
 * For mono-account, accountId defaults to "default".
 */
function ensureBinding(
  config: Record<string, unknown>,
  agentId: string,
  channel: string,
  accountId: string | undefined,
): void {
  const effectiveAccountId = accountId ?? 'default';
  const bindings = (Array.isArray(config.bindings) ? config.bindings : []) as Record<string, unknown>[];

  const exists = bindings.some(
    (b) =>
      b.agentId === agentId &&
      (b.match as Record<string, unknown>)?.channel === channel &&
      ((b.match as Record<string, unknown>)?.accountId ?? 'default') === effectiveAccountId,
  );

  if (!exists) {
    bindings.push({
      agentId,
      match: {
        channel,
        accountId: effectiveAccountId,
      },
    });
    config.bindings = bindings;
  }
}

function removeBindings(config: Record<string, unknown>, agentId: string, channel: string): void {
  const bindings = (Array.isArray(config.bindings) ? config.bindings : []) as Record<string, unknown>[];
  config.bindings = bindings.filter(
    (b) => !(b.agentId === agentId && (b.match as Record<string, unknown>)?.channel === channel),
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

/** Get pending + approved pairings for a channel (telegram | whatsapp) */
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

/** Approve a pending pairing code for a channel (telegram | whatsapp) */
export function approvePairing(agentId: string, code: string, channel: string = 'telegram'): { success: boolean; error?: string } {
  const container = findContainerById(agentId);
  if (!container) return { success: false, error: `Agent container not found: ${agentId}` };

  try {
    const out = containerExecNoFail(container, `openclaw pairing approve ${channel} ${escapeShellArg(code)} 2>&1`);
    if (out && out.includes('error')) {
      return { success: false, error: out };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** Revoke an approved sender from the allowlist for a channel (telegram | whatsapp) */
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
    containerExecNoFail(
      container,
      `node -e "const p='${filePath}';try{const d=JSON.parse(require('fs').readFileSync(p,'utf8'));d.allowFrom=(d.allowFrom||[]).filter(e=>e!=='${senderId.replace(/'/g, "'\\''")}');require('fs').writeFileSync(p,JSON.stringify(d,null,2),'utf8')}catch(e){}"`,
    );

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
