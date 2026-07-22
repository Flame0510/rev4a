import fs from 'node:fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';

const HOST_CRON_PATH = process.env.OPENCLAW_CRON_JOBS_PATH ?? '/data/.openclaw/cron/jobs.json';

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
  source?: 'host' | 'container';
  [key: string]: unknown;
}

export interface OpenClawCronListResult {
  ok: boolean;
  jobs: OpenClawCronJob[];
  total: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function computeNextRun(expr: string, tz?: string): number | null {
  try {
    const interval = CronExpressionParser.parse(expr, tz ? { tz } : {});
    return interval.next().toDate().getTime();
  } catch {
    return null;
  }
}

function normalizeJob(job: OpenClawCronJob): OpenClawCronJob {
  const sched = job.schedule as CronSchedule | undefined;
  const schedExpr =
    typeof job.schedule === 'object' && job.schedule !== null
      ? sched?.expr ?? ''
      : typeof job.schedule === 'string'
        ? job.schedule
        : '';
  const tz = sched?.tz;

  const computedNextRunAtMs =
    job.enabled !== false && schedExpr
      ? computeNextRun(schedExpr, tz ?? undefined)
      : null;

  return {
    ...job,
    scheduleExpr: schedExpr,
    computedNextRunAtMs,
  };
}

function discoverAgentContainers(): { containerName: string; agentId: string }[] {
  try {
    const namesRaw = execFileSync('docker', [
      'ps', '--filter', 'label=AGENT_ID', '--format', '{{.Names}}'
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    if (!namesRaw) return [];

    return namesRaw.split('\n').map(name => {
      const containerName = name.trim();
      if (!containerName) return null;
      let agentId = containerName;
      try {
        agentId = execFileSync('docker', [
          'inspect', containerName, '--format', '{{index .Config.Labels "AGENT_ID"}}'
        ], { encoding: 'utf8', timeout: 5000 }).trim();
      } catch { /* fallback to containerName */ }
      return { containerName, agentId: agentId || containerName };
    }).filter(Boolean) as { containerName: string; agentId: string }[];
  } catch {
    return [];
  }
}

// ── Read jobs from a file path (host or container) ───────────────────────

function readJobsFromFile(filePath: string): OpenClawCronJob[] | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as OpenClawCronJob[];
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { jobs?: unknown[] }).jobs)) {
      return (parsed as { jobs: OpenClawCronJob[] }).jobs;
    }
    return null;
  } catch {
    return null;
  }
}

function readJobsFromContainer(containerName: string): OpenClawCronJob[] | null {
  const containerPath = '/data/.openclaw/cron/jobs.json';
  try {
    const raw = execFileSync('docker', ['exec', containerName, 'cat', containerPath], {
      encoding: 'utf8', timeout: 5000
    });
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as OpenClawCronJob[];
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { jobs?: unknown[] }).jobs)) {
      return (parsed as { jobs: OpenClawCronJob[] }).jobs;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Write jobs to file (host or container) ───────────────────────────────

function writeJobsFile(filePath: string, jobs: OpenClawCronJob[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(jobs, null, 2), 'utf8');
}

function writeJobsToContainer(containerName: string, jobs: OpenClawCronJob[]): void {
  const containerPath = '/data/.openclaw/cron/jobs.json';
  const jsonStr = JSON.stringify(jobs, null, 2);
  // Use stdin pipe instead of base64 injection to avoid shell quoting risks
  execFileSync('docker', ['exec', '-i', containerName, 'sh', '-c',
    `mkdir -p /data/.openclaw/cron && cat > '${containerPath}'`
  ], { input: jsonStr, encoding: 'utf8', timeout: 10000 });
}

// ── List: aggregate from host + all containers ──────────────────────────

export async function listOpenClawCronJobs(): Promise<OpenClawCronListResult> {
  const jobs: OpenClawCronJob[] = [];

  // 1. Host gateway jobs
  const hostJobs = readJobsFromFile(HOST_CRON_PATH);
  if (hostJobs) {
    for (const j of hostJobs) {
      jobs.push({ ...normalizeJob(j), source: 'host' });
    }
  }

  // 2. Container agent jobs
  const agents = discoverAgentContainers();
  for (const agent of agents) {
    const containerJobs = readJobsFromContainer(agent.containerName);
    if (containerJobs) {
      for (const j of containerJobs) {
        jobs.push({ ...normalizeJob(j), containerName: agent.containerName, agentId: agent.agentId, source: 'container' });
      }
    }
  }

  return { ok: true, jobs, total: jobs.length };
}

// ── Patch: find the right source and write back ─────────────────────────

export interface CronPatchResult {
  ok: boolean;
  job?: OpenClawCronJob;
  error?: string;
}

export async function patchCronJob(id: string, patch: Partial<OpenClawCronJob>): Promise<CronPatchResult> {
  // Search across host + containers, with containerName from patch if given
  const containerName = (patch as any).containerName;

  if (containerName) {
    // Patch inside a container
    const containerJobs = readJobsFromContainer(containerName);
    if (!containerJobs) return { ok: false, error: `Cannot read cron jobs from container ${containerName}` };

    const idx = containerJobs.findIndex((j) => j.id === id);
    if (idx === -1) return { ok: false, error: `Job ${id} not found in container ${containerName}` };

    // Strip routing field before persisting
    const { containerName: _routing, ...cleanPatch } = patch;
    containerJobs[idx] = { ...containerJobs[idx], ...cleanPatch };

    try {
      writeJobsToContainer(containerName, containerJobs);
    } catch (e) {
      return { ok: false, error: `Failed to write cron jobs to container ${containerName}: ${String(e)}` };
    }

    return { ok: true, job: normalizeJob(containerJobs[idx]) };
  }

  // Patch on the host gateway
  const hostJobs = readJobsFromFile(HOST_CRON_PATH);
  if (!hostJobs) return { ok: false, error: 'Cannot read host cron jobs file' };

  const idx = hostJobs.findIndex((j) => j.id === id);
  if (idx === -1) return { ok: false, error: `Job ${id} not found` };

  hostJobs[idx] = { ...hostJobs[idx], ...patch };

  try {
    writeJobsFile(HOST_CRON_PATH, hostJobs);
  } catch (e) {
    return { ok: false, error: `Failed to write cron jobs: ${String(e)}` };
  }

  return { ok: true, job: normalizeJob(hostJobs[idx]) };
}
