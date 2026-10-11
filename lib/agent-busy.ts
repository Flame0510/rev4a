/**
 * Whether an agent is in the middle of a long operation that nothing else may touch:
 * an edit (lib/agent-edit.ts), a restore (lib/agent-restore.ts), a recreate
 * (lib/agent-recreate.ts), an update (lib/agent-update.ts), a cold backup
 * (lib/cold-backup.ts), a subscription login (lib/subscription-login.ts) or a subscription
 * disconnect (lib/subscription-actions.ts), or a live memory limit being applied
 * (claimMemoryLimit below). The routes that
 * change an agent answer 409 with this reason.
 */
import { isColdBackupRunning } from '@/lib/cold-backup';
import { isUpdateActive } from '@/lib/agent-update-state';
import { isRecreateActive } from '@/lib/agent-recreate-state';
import { isRestoreActive } from '@/lib/agent-restore-state';
import { isEditActive } from '@/lib/agent-edit-state';
import { isLoginActive } from '@/lib/subscription-login';
import { actionBusyReason } from '@/lib/subscription-actions';

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

/** `ignoreLogin`: for the login's own start, whose placeholder job would otherwise count as busy. */
export async function agentBusyReason(agentId: string, opts?: { ignoreLogin?: boolean }): Promise<string | null> {
  if (memoryLimitClaims.has(agentId)) return 'A memory limit change for this agent is being applied';
  if (isUpdateActive(agentId)) return 'An update of this agent is running';
  if (isRecreateActive(agentId)) return 'A recreate of this agent is running';
  if (isRestoreActive(agentId)) return 'A restore of this agent is running';
  if (isEditActive(agentId)) return 'An edit of this agent is running';
  if (!opts?.ignoreLogin && isLoginActive(agentId)) return 'A subscription login for this agent is running';
  const sub = actionBusyReason(agentId);
  if (sub) return sub;
  if (await isColdBackupRunning(agentId)) return 'A backup of this agent is running';
  return null;
}

