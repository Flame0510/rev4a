import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { dockerExecNoFail, mapWithConcurrency, buildExecArgs, clientTimeoutMs, isWrapperMissing, unwrappedContainers } from '@/lib/docker-exec';

import { gatewayCliArgv } from '@/lib/gateway-cli';
import { describeAgent } from '@/lib/agent-names';

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
    unwrapped.add(containerName);
    return run(false);
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
  source?: 'host' | 'container';
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenClawCronListResult {
  ok: boolean;
  jobs: OpenClawCronJob[];
  total: number;
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

async function discoverAgentContainers(): Promise<AgentInfo[]> {
  try {
    // One `docker ps` for everything. This used to run an extra `docker inspect`
    // per container just to read the AGENT_ID label — but `docker ps` prints
    // labels itself, so that was N+1 process spawns (~260ms each) for data the
    // first call already had.
    const raw = await execFileAsync('docker', [
      'ps', '--filter', 'label=AGENT_ID', '--format', '{{.Label "AGENT_ID"}}\t{{.Names}}',
    ], { encoding: 'utf8', timeout: 5000 });

    return raw.stdout.trim().split('\n')
      .map((line) => {
        const [agentId, containerName] = line.split('\t');
        if (!containerName?.trim()) return null;
        return {
          containerName: containerName.trim(),
          agentId: agentId?.trim() || containerName.trim(),
        };
      })
      .filter(Boolean) as AgentInfo[];
  } catch {
    return [];
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

async function listJobsOnHost(): Promise<OpenClawCronJob[] | null> {
  try {
    // Not a container command — this is the openclaw CLI on the host itself,
    // so it goes through execFile directly rather than the docker-exec helper.
    const raw = await execFileAsync('openclaw', ['cron', 'list', '--json', '--all'], {
      encoding: 'utf8', timeout: 15000,
    });
    return parseCronListOutput(raw.stdout);
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

function toggleOnHost(jobId: string, enabled: boolean): boolean {
  try {
    const action = enabled ? 'enable' : 'disable';
    execFileSync('openclaw', ['cron', action, jobId], {
      encoding: 'utf8', timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function toggleInContainer(containerName: string, jobId: string, enabled: boolean): boolean {
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

// ── List: host gateway + per-container cron ─────────────────────────────

export async function listOpenClawCronJobs(): Promise<OpenClawCronListResult> {
  const seen = new Set<string>();
  const jobs: OpenClawCronJob[] = [];

  // The host query and the agent discovery don't depend on each other, so they
  // overlap. Everything below is ordered deterministically afterwards — host
  // jobs first, then agents in discovery order — so the response doesn't shuffle
  // between polls just because a container answered sooner this time.
  const [hostJobs, agents] = await Promise.all([
    listJobsOnHost(),
    discoverAgentContainers(),
  ]);

  // 1. Host gateway cron jobs
  if (hostJobs) {
    for (const job of hostJobs) {
      job.scheduleExpr = extractScheduleExpr(job);
      job.source = 'host';
      jobs.push(job);
      if (job.id) seen.add(job.id);
    }
  }

  // 2. Agent container cron jobs — queried concurrently, merged in order.
  const perAgent = await mapWithConcurrency(
    agents,
    AGENT_QUERY_CONCURRENCY,
    (agent) => listJobsInContainer(agent.containerName),
  );

  for (const [i, containerJobs] of perAgent.entries()) {
    if (!containerJobs) continue;
    const agent = agents[i];
    for (const job of containerJobs) {
      job.scheduleExpr = extractScheduleExpr(job);
      job.source = 'container';
      job.containerName = agent.containerName;
      if (!job.agentId) job.agentId = agent.agentId;

      if (job.id && seen.has(job.id)) continue;

      jobs.push(job);
      if (job.id) seen.add(job.id);
    }
  }

  return { ok: true, jobs, total: jobs.length };
}

// ── Patch: try container first (if containerName given), then host ──────

export interface CronPatchResult {
  ok: boolean;
  job?: OpenClawCronJob;
  error?: string;
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

  const containerName = (patch as any).containerName;

  if (containerName) {
    const ok = toggleInContainer(containerName, id, patch.enabled);
    if (ok) return { ok: true, job: { id, enabled: patch.enabled } as OpenClawCronJob };
    return { ok: false, error: `Failed to toggle cron in ${describeAgent(containerName)}` };
  }

  const ok = toggleOnHost(id, patch.enabled);
  if (ok) return { ok: true, job: { id, enabled: patch.enabled } as OpenClawCronJob };
  return { ok: false, error: 'Failed to toggle cron on host gateway' };
}

// ── Remove ─────────────────────────────────────────────────────────────

export interface CronRemoveResult {
  ok: boolean;
  error?: string;
}

function removeOnHost(jobId: string): boolean {
  try {
    execFileSync('openclaw', ['cron', 'remove', jobId], {
      encoding: 'utf8', timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function removeInContainer(containerName: string, jobId: string): boolean {
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
  if (containerName) {
    const ok = removeInContainer(containerName, id);
    if (ok) return { ok: true };
    return { ok: false, error: `Failed to remove cron job in ${describeAgent(containerName)}` };
  }

  const ok = removeOnHost(id);
  if (ok) return { ok: true };
  return { ok: false, error: 'Failed to remove cron job on host gateway' };
}
