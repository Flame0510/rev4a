import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { dockerExecNoFail, mapWithConcurrency, buildExecArgs, clientTimeoutMs, isWrapperMissing, unwrappedContainers } from '@/lib/docker-exec';

import { gatewayCliArgv } from '@/lib/gateway-cli';
import { describeAgent, CONTAINER_NAME_RE } from '@/lib/agent-names';
import { isValidCronJobId } from '@/lib/cron-ids';

const execFileAsync = promisify(execFile);

/**
 * `docker exec` for the synchronous cron paths, with the command bounded INSIDE the
 * container (`timeout -k 5`): killing only the docker client at the host-side
 * deadline would leave the OpenClaw CLI running there. The gateway URL is not a secret.
 * An image without `timeout` is retried once without the wrapper.
 */
function dockerExecSync(containerName: string, gwUrl: string, argv: string[], timeoutMs: number): string {
  const unwrapped = unwrappedContainers();
  const run = (wrap: boolean) => {
    const args = buildExecArgs({ container: containerName, argv, timeoutMs, wrap });
    args.splice(1, 0, '-e', `OPENCLAW_GATEWAY_URL=${gwUrl}`);
    return execFileSync('docker', args, { encoding: 'utf8', timeout: wrap ? clientTimeoutMs(timeoutMs) : timeoutMs });
  };
  if (unwrapped.has(containerName)) return run(false);
  try {
    return run(true);
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    if (!isWrapperMissing(err.status, `${err.stdout ?? ''}\n${err.stderr ?? ''}`)) throw e;
    // The command's own output is never enough (a job id echoed in an error can hold "Usage: timeout"):
    // a probe of the wrapper itself decides, as in runWithWrapperFallback (lib/docker-exec.ts).
    if (!wrapperReallyMissingSync(containerName)) throw e;
    unwrapped.add(containerName);
    return run(false);
  }
}

/** True only when `timeout -k 1 5 true` itself fails in the container the way a missing wrapper does. */
function wrapperReallyMissingSync(containerName: string): boolean {
  try {
    execFileSync('docker', ['exec', containerName, 'timeout', '-k', '1', '5', 'true'], { encoding: 'utf8', timeout: 8000 });
    return false;
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return typeof err.status === 'number' && isWrapperMissing(err.status, `${err.stdout ?? ''}\n${err.stderr ?? ''}`);
  }
}

/**
 * How many agents to query at once.
 *
 * Each one costs a `docker exec` plus an OpenClaw CLI boot — ~2.5-3s measured,
 * and the route used to pay them in sequence: 19.2s on a seven-agent host, with
 * the event loop blocked throughout. Running them concurrently makes the total
 * the slowest agent rather than the sum. The cap is here because every one of
 * these is a process, and the Docker daemon serialises past a point regardless.
 */
const AGENT_QUERY_CONCURRENCY = 6;

// ── Types ─────────────────────────────────────────────────────────────────

export interface CronSchedule {
  kind?: string;
  expr?: string;
  tz?: string;
  [key: string]: unknown;
}

export interface CronPayload {
  kind?: string;
  text?: string;
  message?: string;
  model?: string;
  fallbacks?: string[];
  [key: string]: unknown;
}

export interface CronState {
  lastStatus?: string;
  nextRunAtMs?: number | null;
  lastRunAtMs?: number | null;
  [key: string]: unknown;
}

export interface OpenClawCronJob {
  id?: string;
  name?: string;
  description?: string;
  agentId?: string;
  /** Rev4a's container label; distinct from the job's internal OpenClaw agentId. */
  rev4aAgentId?: string;
  containerName?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  scheduleExpr?: string;
  state?: CronState;
  payload?: CronPayload;
  createdAtMs?: number;
  updatedAtMs?: number;
  sessionTarget?: string;
  wakeMode?: string;
  source?: 'container';
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** One agent whose cron jobs could not be read (it did not answer, or answered garbage). */
export interface CronReadError {
  container: string;
  error: string;
}

export interface OpenClawCronListResult {
  ok: boolean;
  jobs: OpenClawCronJob[];
  total: number;
  /** True when `docker ps` failed: the jobs list is empty because nothing could be asked, not because there are none. */
  dockerUnavailable: boolean;
  /** Agents that were running but whose jobs could not be read. */
  errors: CronReadError[];
}

export interface AgentInfo {
  agentId: string;
  containerName: string;
}

// ── Extract schedule expression ──────────────────────────────────────────

function extractScheduleExpr(job: OpenClawCronJob): string {
  if (job.scheduleExpr) return job.scheduleExpr;
  if (typeof job.schedule === 'string') return job.schedule;
  if (job.schedule && typeof job.schedule === 'object') {
    return (job.schedule as any).expr ?? '';
  }
  return '';
}

// ── Discover agent containers ────────────────────────────────────────────

async function discoverAgentContainers(): Promise<{ agents: AgentInfo[]; dockerUnavailable: boolean }> {
  try {
    // One `docker ps` for everything. This used to run an extra `docker inspect`
    // per container just to read the AGENT_ID label — but `docker ps` prints
    // labels itself, so that was N+1 process spawns (~260ms each) for data the
    // first call already had.
    const raw = await execFileAsync('docker', [
      'ps', '--filter', 'label=AGENT_ID', '--format', '{{.Label "AGENT_ID"}}\t{{.Names}}',
    ], { encoding: 'utf8', timeout: 5000 });

    const agents = raw.stdout.trim().split('\n')
      .map((line) => {
        const [agentId, containerName] = line.split('\t');
        if (!containerName?.trim()) return null;
        return {
          containerName: containerName.trim(),
          agentId: agentId?.trim() || containerName.trim(),
        };
      })
      .filter(Boolean) as AgentInfo[];
    return { agents, dockerUnavailable: false };
  } catch {
    return { agents: [], dockerUnavailable: true };
  }
}

// ── Parse CLI output ─────────────────────────────────────────────────────

function parseCronListOutput(raw: string): OpenClawCronJob[] | null {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (Array.isArray(parsed)) return parsed as OpenClawCronJob[];
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { jobs?: unknown[] }).jobs)) {
      return (parsed as { jobs: OpenClawCronJob[] }).jobs;
    }
    return null;
  } catch {
    return null;
  }
}

async function listJobsInContainer(containerName: string): Promise<OpenClawCronJob[] | null> {
  // Try both common agent gateway ports. Agents default to 3000 (OpenClaw
  // gateway --bind lan --port 3000) but may also run on 18789 (default).
  // Kept sequential on purpose: the second is a fallback for the first, so
  // firing both would double the load to discard one answer.
  const gatewayUrls = [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:18789',
  ];

  for (const gwUrl of gatewayUrls) {
    const raw = await dockerExecNoFail(
      containerName,
      gatewayCliArgv(['cron', 'list', '--json', '--all'], { port: null }),
      { env: { OPENCLAW_GATEWAY_URL: gwUrl }, timeoutMs: 15000 },
    );
    if (!raw) continue;
    const parsed = parseCronListOutput(raw);
    if (parsed) return parsed;
  }

  return null;
}

// ── PATCH helpers ────────────────────────────────────────────────────────

function toggleInContainer(containerName: string, jobId: string, enabled: boolean): boolean {
  if (!isValidCronJobId(jobId)) return false;
  const gatewayUrls = [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:18789',
  ];
  for (const gwUrl of gatewayUrls) {
    try {
      const action = enabled ? 'enable' : 'disable';
      dockerExecSync(containerName, gwUrl, gatewayCliArgv(['cron', action, jobId], { port: null }), 10000);
      return true;
    } catch { /* try next gateway port */ }
  }
  return false;
}

// ── List: per-container cron ─────────────────────────────

export async function listOpenClawCronJobs(): Promise<OpenClawCronListResult> {
  const seen = new Set<string>();
  const jobs: OpenClawCronJob[] = [];

  const { agents, dockerUnavailable } = await discoverAgentContainers();
  const errors: CronReadError[] = [];

  // Agent container cron jobs, queried concurrently and merged in discovery order, so the
  // response doesn't shuffle between polls just because a container answered sooner.
  const perAgent = await mapWithConcurrency(
    agents,
    AGENT_QUERY_CONCURRENCY,
    (agent) => listJobsInContainer(agent.containerName),
  );

  for (const [i, containerJobs] of perAgent.entries()) {
    const agent = agents[i];
    if (!containerJobs) {
      errors.push({ container: agent.containerName, error: 'The agent did not answer' });
      continue;
    }
    for (const job of containerJobs) {
      job.scheduleExpr = extractScheduleExpr(job);
      job.source = 'container';
      job.containerName = agent.containerName;
      // Discovery owns this field. An upstream job cannot choose a different Rev4a agent.
      job.rev4aAgentId = agent.agentId;
      if (!job.agentId) job.agentId = agent.agentId;

      if (job.id && seen.has(job.id)) continue;

      jobs.push(job);
      if (job.id) seen.add(job.id);
    }
  }

  return { ok: true, jobs, total: jobs.length, dockerUnavailable, errors };
}

// ── Patch: always inside an agent container ─────────────────────────────

export interface CronPatchResult {
  ok: boolean;
  job?: OpenClawCronJob;
  error?: string;
  /** True when the request named no valid container (HTTP 400). */
  badRequest?: boolean;
}

// ── Cron run history ─────────────────────────────────────────────────────

export interface CronRunEntry {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  error?: string;
  summary?: string;
  runId?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: Record<string, number>;
  diagnostics?: {
    summary?: string;
    entries?: Array<{ ts?: number; source?: string; severity?: string; message?: string }>;
  };
  [key: string]: unknown;
}

export interface CronRunsResult {
  ok: boolean;
  entries: CronRunEntry[];
  error?: string;
}

export function getCronRuns(
  containerName: string,
  jobId: string,
  limit: number = 20,
): CronRunsResult {
  if (!isValidCronJobId(jobId)) return { ok: false, entries: [], error: 'Invalid job id' };
  const gatewayUrls = [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:18789',
  ];

  for (const gwUrl of gatewayUrls) {
    try {
      const raw = dockerExecSync(containerName, gwUrl, gatewayCliArgv(['cron', 'runs', '--id', jobId, '--limit', String(limit)], { port: null }), 15000);

      const parsed = JSON.parse(raw.trim()) as { entries?: CronRunEntry[] };
      // Accept both empty and populated entries arrays
      if (parsed && Array.isArray(parsed.entries)) {
        return { ok: true, entries: parsed.entries };
      }
      // Not the expected format; try next port
    } catch { /* try next gateway port */ }
  }

  return { ok: false, entries: [], error: 'Cannot connect to container gateway for runs' };
}

export function patchCronJob(id: string, patch: Partial<OpenClawCronJob>): CronPatchResult {
  if (typeof patch.enabled !== 'boolean') {
    return { ok: false, error: 'Only the enabled field can be patched' };
  }

  if (!isValidCronJobId(id)) return { ok: false, error: 'Invalid job id', badRequest: true };

  const containerName = patch.containerName;
  if (typeof containerName !== 'string' || !CONTAINER_NAME_RE.test(containerName)) {
    return { ok: false, error: 'A valid containerName is required', badRequest: true };
  }

  const ok = toggleInContainer(containerName, id, patch.enabled);
  if (ok) return { ok: true, job: { id, enabled: patch.enabled } as OpenClawCronJob };
  return { ok: false, error: `Failed to toggle cron in ${describeAgent(containerName)}` };
}

// ── Remove ─────────────────────────────────────────────────────────────

export interface CronRemoveResult {
  ok: boolean;
  error?: string;
  /** True when the request named no valid container (HTTP 400). */
  badRequest?: boolean;
}

function removeInContainer(containerName: string, jobId: string): boolean {
  if (!isValidCronJobId(jobId)) return false;
  const gatewayUrls = [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:18789',
  ];
  for (const gwUrl of gatewayUrls) {
    try {
      dockerExecSync(containerName, gwUrl, gatewayCliArgv(['cron', 'remove', jobId], { port: null }), 10000);
      return true;
    } catch { /* try next gateway port */ }
  }
  return false;
}

export function removeCronJob(id: string, containerName?: string): CronRemoveResult {
  if (!isValidCronJobId(id)) return { ok: false, error: 'Invalid job id', badRequest: true };
  if (typeof containerName !== 'string' || !CONTAINER_NAME_RE.test(containerName)) {
    return { ok: false, error: 'A valid containerName is required', badRequest: true };
  }
  const ok = removeInContainer(containerName, id);
  if (ok) return { ok: true };
  return { ok: false, error: `Failed to remove cron job in ${describeAgent(containerName)}` };
}
