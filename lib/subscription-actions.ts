/**
 * Background job for the one slow subscription action of an agent: disconnecting it (it stops
 * using the subscription model, then signs out). Like the device-code login
 * (lib/subscription-login.ts) it is in-memory, one per agent: the route answers 202 at once,
 * the page polls the job and refreshes that one row when it ends. A dashboard restart loses the
 * job record, not the work in the agent: the page's next read of the row shows what the agent
 * now holds. Choosing the model is not a job: the agent panel's MODEL section does it through
 * PUT /api/gateway/agent.
 *
 * A running job makes the agent busy (lib/agent-busy.ts), so a recreate, update or edit
 * cannot start meanwhile. The work itself runs under the per-agent lock of
 * lib/subscriptions.ts.
 */
import { isValidAgentId } from '@/lib/container';
import { SubscriptionError, disconnectAgent } from '@/lib/subscriptions';
import { waitForLoginExit } from '@/lib/subscription-login';

export type ActionKind = 'logout';
export type ActionState = 'running' | 'done' | 'failed';

export interface ActionView {
  agentId: string;
  kind: ActionKind;
  state: ActionState;
  error: string | null;
}

interface Job extends ActionView {
  finishedAt: number | null;
}

const FINISHED_KEEP_MS = 30 * 60_000;
const g = globalThis as unknown as { __rev4aSubActions?: Map<string, Job> };
const jobs = (): Map<string, Job> => (g.__rev4aSubActions ??= new Map());

const view = (j: Job): ActionView => ({ agentId: j.agentId, kind: j.kind, state: j.state, error: j.error });

function prune(): void {
  const now = Date.now();
  for (const [id, j] of jobs()) {
    if (j.finishedAt && now - j.finishedAt > FINISHED_KEEP_MS) jobs().delete(id);
  }
}

/** Why the agent is busy because of one of these jobs, or null (read by lib/agent-busy.ts). */
export function actionBusyReason(agentId: string): string | null {
  const j = jobs().get(agentId);
  if (!j || j.state !== 'running') return null;
  return 'A subscription disconnect for this agent is running';
}

/**
 * Start a job and return it at once. The caller has already checked that the agent exists,
 * runs and is not busy; the registration below is synchronous, so two requests in a row
 * cannot both start (the second gets 409).
 */
export function startAction(kind: ActionKind, agentId: unknown): ActionView {
  if (typeof agentId !== 'string' || !isValidAgentId(agentId)) throw new SubscriptionError(400, 'Invalid agent id');
  const running = jobs().get(agentId);
  if (running && running.state === 'running') {
    throw new SubscriptionError(409, actionBusyReason(agentId) ?? 'A subscription change for this agent is running');
  }
  prune();
  const j: Job = { agentId, kind, state: 'running', error: null, finishedAt: null };
  jobs().set(agentId, j);
  // A login that just connected may still be writing the config: let it finish first.
  const work: Promise<unknown> = waitForLoginExit(agentId).then((): Promise<unknown> => disconnectAgent(agentId));
  work.then(
    () => { j.state = 'done'; j.finishedAt = Date.now(); },
    (e: unknown) => {
      j.state = 'failed';
      j.finishedAt = Date.now();
      j.error = e instanceof SubscriptionError ? e.message : 'Disconnect failed';
    },
  );
  return view(j);
}

/** The latest job of this kind for the agent (running or finished), or null. */
export function getAction(agentId: string, kind?: ActionKind): ActionView | null {
  const j = jobs().get(agentId);
  if (!j || (kind && j.kind !== kind)) return null;
  return view(j);
}
