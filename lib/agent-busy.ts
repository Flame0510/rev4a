/**
 * Whether an agent is in the middle of a long operation that nothing else may touch:
 * an edit (lib/agent-edit.ts), a restore (lib/agent-restore.ts), a recreate
 * (lib/agent-recreate.ts), an update (lib/agent-update.ts), a cold backup
 * (lib/cold-backup.ts), a subscription login (lib/subscription-login.ts) or a subscription
 * disconnect (lib/subscription-actions.ts). The routes that
 * change an agent answer 409 with this reason.
 */
import { isColdBackupRunning } from '@/lib/cold-backup';
import { isUpdateActive } from '@/lib/agent-update-state';
import { isRecreateActive } from '@/lib/agent-recreate-state';
import { isRestoreActive } from '@/lib/agent-restore-state';
import { isEditActive } from '@/lib/agent-edit-state';
import { isLoginActive } from '@/lib/subscription-login';
import { actionBusyReason } from '@/lib/subscription-actions';

/** `ignoreLogin`: for the login's own start, whose placeholder job would otherwise count as busy. */
export async function agentBusyReason(agentId: string, opts?: { ignoreLogin?: boolean }): Promise<string | null> {
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

