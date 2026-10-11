/**
 * What an agent container says about its system packages: the list `rev4a-apt` keeps and the
 * outcome of the last `rev4a-packages-restore` (FEAT-14). Read-only, with argv exec only; the
 * files come from inside the container and are parsed defensively (lib/agent-packages.js).
 */
import { dockerExec } from '@/lib/docker-exec';
import { inspectAgentContainer } from '@/lib/agent-recreate';
import { parsePackageList, parseStatus, type PackageEntry, type PackagesStatus } from '@/lib/agent-packages';

const READ_TIMEOUT_MS = 5000;
const READ_MAX_BYTES = 1024 * 1024;
const APT_WRAPPER = '/usr/local/sbin/rev4a-apt';
const STATUS_FILE = '/root/.rev4a/packages-status.json';
const LIST_FILE = '/root/.rev4a/packages.txt';

export interface AgentPackages {
  /** The image has the recorder (`rev4a-apt`); false for an agent that predates it. */
  supported: boolean;
  running: boolean;
  /** Docker says running but exec is refused: the container is paused or restarting. */
  transient?: 'paused' | 'restarting';
  /** The read failed (not "unsupported"); the other fields are then empty. */
  error?: string;
  status: PackagesStatus | null;
  packages: PackageEntry[];
}

/** Docker reports Running true for a paused or restarting container; exec is refused on both. */
interface ExecState { Paused?: boolean; Restarting?: boolean }

const opts = { timeoutMs: READ_TIMEOUT_MS, maxBuffer: READ_MAX_BYTES };

/** The text of a file in the container, or null when it cannot be read (missing, too large, timeout). */
async function readFile(container: string, file: string): Promise<string | null> {
  try {
    return await dockerExec(container, ['cat', file], opts);
  } catch {
    return null;
  }
}

/** null when no container carries the agent id. */
export async function readAgentPackages(agentId: string): Promise<AgentPackages | null> {
  const info = await inspectAgentContainer(agentId);
  if (!info || typeof info.Id !== 'string') return null;
  if (!info.State?.Running) return { supported: true, running: false, status: null, packages: [] };
  const state = info.State as ExecState;
  if (state.Paused) return { supported: true, running: true, transient: 'paused', status: null, packages: [] };
  if (state.Restarting) return { supported: true, running: true, transient: 'restarting', status: null, packages: [] };

  // Only an exit code of 1 from `test -x` means "no recorder"; a timeout or a Docker error says nothing about the image.
  let supported = true;
  try {
    await dockerExec(info.Id, ['test', '-x', APT_WRAPPER], opts);
  } catch (e) {
    if (/: exit 1$/.test((e as Error).message)) supported = false;
    else return { supported: true, running: true, error: "Could not read the agent's packages", status: null, packages: [] };
  }
  if (!supported) return { supported: false, running: true, status: null, packages: [] };

  const [statusText, listText] = await Promise.all([readFile(info.Id, STATUS_FILE), readFile(info.Id, LIST_FILE)]);
  return {
    supported: true,
    running: true,
    status: statusText === null ? null : parseStatus(statusText),
    packages: listText === null ? [] : parsePackageList(listText),
  };
}
