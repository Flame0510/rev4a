/**
 * FEAT-27.1: Claude runs start lean.
 *
 * On `claude-cli` turns OpenClaw sends every tool definition on every turn (~16k tokens of tools no
 * agent uses on Claude). `tools.byProvider.anthropic.deny` switches tools off for runs whose provider
 * is `anthropic` (the Claude plan through Claude Code) only; every other model is unaffected.
 *
 * Rev4a writes the default list below ONLY when the key is absent: an operator's or agent's own list
 * (even `[]`) is never touched. The agent may switch a tool back on itself (rev4a-rules/AGENTS.md).
 * Disconnecting Claude leaves the list in place: it applies to anthropic runs only, so it is harmless.
 *
 * Every read and write goes through `withAgentConfigLock`, in ONE hold per agent (the decision depends
 * on what the read returned). This module runs in the Next.js server only: the daemon has no lock.
 */
import { dockerExec, dockerExecWithInput } from '@/lib/docker-exec';
import { withAgentConfigLock } from '@/lib/agent-config-lock';
import { OPENCLAW_RELOAD_TIMEOUT_MS } from '@/lib/credentials/native';
import { claudeRuleFromConfigText } from '@/lib/claude-cli-label';

/**
 * Tools switched off on Claude runs, by group:
 * - devices and screens an agent container does not have: computer, mobile_ui, nodes, node_inference,
 *   presence, screen, talk_voice;
 * - OpenClaw UI pieces: canvas, theme, dashboard, portal, terminal, show_widget;
 * - duplicates of Claude Code's own file tools: file_fetch, file_write, dir_fetch, dir_list;
 * - Codex-only goal and plugin features: create_goal, get_goal, update_goal, intent, codex_plugins;
 * - meeting transcripts and the OpenClaw setup helper: transcripts, openclaw.
 * Everything else stays on on purpose: exec/process/fs, message, automations/cron,
 * sessions/subagents/agents, web, memory, browser, pdf, tts, image tools, progress_card,
 * skill_workshop, gateway, secrets, conversations.
 */
export const CLAUDE_LEAN_TOOLS_DENY: readonly string[] = [
  'computer', 'mobile_ui', 'nodes', 'node_inference', 'presence', 'screen', 'talk_voice',
  'canvas', 'theme', 'dashboard', 'portal', 'terminal', 'show_widget',
  'file_fetch', 'file_write', 'dir_fetch', 'dir_list',
  'create_goal', 'get_goal', 'update_goal', 'intent', 'transcripts', 'codex_plugins', 'openclaw',
];

export const LEAN_TOOLS_PATCH = {
  tools: { byProvider: { anthropic: { deny: [...CLAUDE_LEAN_TOOLS_DENY] } } },
};

export type LeanToolsDecision = 'write' | 'present' | 'not-claude' | 'invalid';
export type LeanToolsResult = 'written' | 'present' | 'not-claude' | 'invalid' | 'failed';

const CONFIG_PATH = '/root/.openclaw/openclaw.json';
const READ_TIMEOUT_MS = 15_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pure: what to do for the text of one agent's openclaw.json. */
export function decideLeanTools(configText: string): LeanToolsDecision {
  let cfg: unknown;
  try {
    cfg = JSON.parse(configText);
  } catch {
    return 'invalid';
  }
  if (!isPlainObject(cfg)) return 'invalid';
  if (claudeRuleFromConfigText(configText) !== true) return 'not-claude';
  if (!('tools' in cfg)) return 'write';
  // Never patch over a shape we do not understand.
  if (!isPlainObject(cfg.tools)) return 'present';
  if (!('byProvider' in cfg.tools)) return 'write';
  if (!isPlainObject(cfg.tools.byProvider)) return 'present';
  if (!('anthropic' in cfg.tools.byProvider)) return 'write';
  const anthropic = cfg.tools.byProvider.anthropic;
  if (!isPlainObject(anthropic)) return 'present';
  return Object.prototype.hasOwnProperty.call(anthropic, 'deny') ? 'present' : 'write';
}

function listApplied(configText: string): boolean {
  try {
    const deny = (JSON.parse(configText) as { tools?: { byProvider?: { anthropic?: { deny?: unknown } } } })
      ?.tools?.byProvider?.anthropic?.deny;
    return Array.isArray(deny)
      && deny.length === CLAUDE_LEAN_TOOLS_DENY.length
      && CLAUDE_LEAN_TOOLS_DENY.every((name, i) => deny[i] === name);
  } catch {
    return false;
  }
}

/** Write the default list into one agent when its Claude route is on and the key is absent. Never throws. */
export async function ensureLeanClaudeTools(container: string): Promise<LeanToolsResult> {
  let result: LeanToolsResult;
  try {
    result = await withAgentConfigLock(container, async (): Promise<LeanToolsResult> => {
      const text = await dockerExec(container, ['cat', CONFIG_PATH], { timeoutMs: READ_TIMEOUT_MS });
      const decision = decideLeanTools(text);
      if (decision !== 'write') return decision;
      try {
        await dockerExecWithInput(
          container,
          ['openclaw', 'config', 'patch', '--stdin'],
          JSON.stringify(LEAN_TOOLS_PATCH),
          { timeoutMs: OPENCLAW_RELOAD_TIMEOUT_MS },
        );
      } catch {
        // On 10.10 a patch can outlast its exec while the Gateway reloads: the read-back decides.
      }
      try {
        const after = await dockerExec(container, ['cat', CONFIG_PATH], { timeoutMs: READ_TIMEOUT_MS });
        return listApplied(after) ? 'written' : 'failed';
      } catch {
        return 'failed';
      }
    });
  } catch {
    result = 'failed';
  }
  if (result === 'written') {
    console.log(`[claude] switched off ${CLAUDE_LEAN_TOOLS_DENY.length} unused tools on Claude runs in ${container} (tools.byProvider.anthropic.deny)`);
  } else if (result === 'failed' || result === 'invalid') {
    console.warn(`[claude] could not switch off unused tools on Claude runs in ${container}: ${result}`);
  }
  return result;
}

/**
 * Installs already connected to Claude: one pass at dashboard startup over the RUNNING agents,
 * one at a time, a slow or failed one never stops the others. Stopped agents get it at a later start.
 */
export async function repairLeanClaudeToolsAtStartup(): Promise<number> {
  const { listAgentContainers } = await import('@/lib/agent-containers');
  let rows: Awaited<ReturnType<typeof listAgentContainers>>;
  try {
    rows = await listAgentContainers();
  } catch {
    return 0;
  }
  let written = 0;
  for (const row of rows) {
    if (!row.running) continue;
    if (await ensureLeanClaudeTools(row.container) === 'written') written++;
  }
  if (written) console.log(`[claude] switched off unused tools on Claude runs in ${written} agent(s) on startup`);
  return written;
}
