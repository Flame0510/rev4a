/**
 * Whether an agent is in the middle of a long operation that nothing else may touch:
 * an edit (lib/agent-edit.ts), a restore (lib/agent-restore.ts), a recreate
 * (lib/agent-recreate.ts), an update (lib/agent-update.ts) or a cold backup
 * (lib/cold-backup.ts). The routes that change an agent answer 409 with this reason.
 */
import { isColdBackupRunning } from '@/lib/cold-backup';
import { isUpdateActive } from '@/lib/agent-update-state';
import { isRecreateActive } from '@/lib/agent-recreate-state';
import { isRestoreActive } from '@/lib/agent-restore-state';
import { isEditActive } from '@/lib/agent-edit-state';

export async function agentBusyReason(agentId: string): Promise<string | null> {
  if (isUpdateActive(agentId)) return 'An update of this agent is running';
  if (isRecreateActive(agentId)) return 'A recreate of this agent is running';
  if (isRestoreActive(agentId)) return 'A restore of this agent is running';
  if (isEditActive(agentId)) return 'An edit of this agent is running';
  if (await isColdBackupRunning(agentId)) return 'A backup of this agent is running';
  return null;
}

