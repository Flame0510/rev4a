/**
 * Whether an agent is in the middle of a long operation that nothing else may touch:
 * an edit (lib/agent-edit.ts), a restore (lib/agent-restore.ts), a recreate
 * (lib/agent-recreate.ts), an update (lib/agent-update.ts), a cold backup
 * (lib/cold-backup.ts), a subscription login (lib/subscription-login.ts for ChatGPT,
 * lib/subscription-claude.ts for Claude) or a subscription disconnect (lib/subscription-actions.ts),
 * or a live memory limit being applied (claimMemoryLimit below). The routes that
 * change an agent answer 409 with this reason.
 */
import { isColdBackupRunning } from '@/lib/cold-backup';
import { isUpdateActive } from '@/lib/agent-update-state';
import { isRecreateActive } from '@/lib/agent-recreate-state';
import { isRestoreActive } from '@/lib/agent-restore-state';
import { isEditActive } from '@/lib/agent-edit-state';
import { isLoginActive } from '@/lib/subscription-login';
import { actionBusyReason } from '@/lib/subscription-actions';

/**
 * A running Claude login is registered by lib/subscription-claude.ts on globalThis. Asking
 * through that function keeps this module free of the Docker and job machinery of every
 * provider, and lets those tests that load this file with a fixed set of dependencies keep
 * working: an unknown module here would mean a new dependency in every busy check.
 */
function claudeLoginActive(agentId: string): boolean {
  const hook = (globalThis as unknown as { __rev4aClaudeLoginActive?: (id: string) => boolean }).__rev4aClaudeLoginActive;
  return typeof hook === 'function' ? hook(agentId) : false;
}

// In-process claim held while `docker update` applies a memory limit. On globalThis so every
// route bundle sees the same set.
const g = globalThis as unknown as { __rev4aMemoryLimitClaims?: Set<string> };
const memoryLimitClaims: Set<string> = (g.__rev4aMemoryLimitClaims ??= new Set<string>());

/** Takes the claim; false when this agent already has one. Synchronous, so check-and-claim cannot interleave. */
export function claimMemoryLimit(agentId: string): boolean {
  if (memoryLimitClaims.has(agentId)) return false;
  memoryLimitClaims.add(agentId);
  return true;
}

export function releaseMemoryLimit(agentId: string): void {
  memoryLimitClaims.delete(agentId);
}

/**
 * Which login the caller is starting itself, so the placeholder job it just registered does not
 * count as busy: `true` skips both (the historical meaning), a provider id only that provider.
 */
export type IgnoreLogin = boolean | 'openai' | 'anthropic';

/** `true` skips both logins (the historical meaning); a provider id only that provider's. */
function ignoreLoginSkips(ignore: IgnoreLogin | undefined, provider: 'openai' | 'anthropic'): boolean {
  return ignore === true || ignore === provider;
}

/** Synchronous owners, also revalidated inside the short lifecycle command reservation. */
export function currentBusyReason(agentId: string, opts?: { ignoreLogin?: IgnoreLogin }): string | null {
  if (memoryLimitClaims.has(agentId)) return 'A memory limit change for this agent is being applied';
  if (isUpdateActive(agentId)) return 'An update of this agent is running';
  if (isRecreateActive(agentId)) return 'A recreate of this agent is running';
  if (isRestoreActive(agentId)) return 'A restore of this agent is running';
  if (isEditActive(agentId)) return 'An edit of this agent is running';
  if (!ignoreLoginSkips(opts?.ignoreLogin, 'openai') && isLoginActive(agentId)) return 'A subscription login for this agent is running';
  if (!ignoreLoginSkips(opts?.ignoreLogin, 'anthropic') && claudeLoginActive(agentId)) return 'A subscription login for this agent is running';
  const sub = actionBusyReason(agentId);
  if (sub) return sub;
  return null;
}

/** `ignoreLogin`: for the login's own start, whose placeholder job would otherwise count as busy. */
export async function agentBusyReason(agentId: string, opts?: { ignoreLogin?: IgnoreLogin }): Promise<string | null> {
  const before = currentBusyReason(agentId, opts);
  if (before) return before;
  if (await isColdBackupRunning(agentId)) return 'A backup of this agent is running';
  // A lifecycle job or sign-in may have claimed this agent while Docker answered.
  return currentBusyReason(agentId, opts);
}

