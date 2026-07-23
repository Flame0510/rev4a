import { execFileSync } from 'child_process';

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

function discoverAgentContainers(): AgentInfo[] {
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
      } catch { /* fallback */ }
      return { containerName, agentId: agentId || containerName };
    }).filter(Boolean) as AgentInfo[];
  } catch {
    return [];
  }
}

// ── Read cron jobs from a single source ──────────────────────────────────

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

function listJobsOnHost(): OpenClawCronJob[] | null {
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], {
      encoding: 'utf8', timeout: 15000,
    });
    return parseCronListOutput(raw);
  } catch {
    return null;
  }
}

function listJobsInContainer(containerName: string): OpenClawCronJob[] | null {
  // Strategy 1: use OpenClaw CLI (needs active gateway)
  try {
    const raw = execFileSync('docker', ['exec', containerName, 'openclaw', 'cron', 'list', '--json'], {
      encoding: 'utf8', timeout: 15000,
    });
    return parseCronListOutput(raw);
  } catch {
    // Gateway not running — fall back to reading the jobs file directly
  }

  // Strategy 2: read ~/.openclaw/cron/jobs.json directly
  // OpenClaw doc: 'Job definitions persist at ~/.openclaw/cron/jobs.json'
  for (const path of ['/root/.openclaw/cron/jobs.json', '/data/.openclaw/cron/jobs.json']) {
    try {
      const raw = execFileSync('docker', ['exec', containerName, 'cat', path], {
        encoding: 'utf8', timeout: 5000,
      });
      const parsed = parseCronListOutput(raw);
      if (parsed) return parsed;
    } catch { /* try next path */ }
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
  try {
    const action = enabled ? 'enable' : 'disable';
    execFileSync('docker', ['exec', containerName, 'openclaw', 'cron', action, jobId], {
      encoding: 'utf8', timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── List: host cron + per-container cron ────────────────────────────────

export async function listOpenClawCronJobs(): Promise<OpenClawCronListResult> {
  const seen = new Set<string>();
  const jobs: OpenClawCronJob[] = [];

  // 1. Host gateway cron jobs
  const hostJobs = listJobsOnHost();
  if (hostJobs) {
    for (const job of hostJobs) {
      job.scheduleExpr = extractScheduleExpr(job);
      job.source = 'host';
      jobs.push(job);
      if (job.id) seen.add(job.id);
    }
  }

  // 2. Per-container cron jobs (docker exec openclaw cron list --json)
  const agents = discoverAgentContainers();
  const agentToContainer = new Map(agents.map(a => [a.agentId, a.containerName]));

  for (const agent of agents) {
    const containerJobs = listJobsInContainer(agent.containerName);
    if (containerJobs) {
      for (const job of containerJobs) {
        job.scheduleExpr = extractScheduleExpr(job);
        job.source = 'container';
        job.containerName = agent.containerName;
        if (!job.agentId) job.agentId = agent.agentId;

        // If same id already came from host, merge fields instead of duplicating
        if (job.id && seen.has(job.id)) {
          const existing = jobs.find(j => j.id === job.id);
          if (existing) {
            existing.containerName = agent.containerName;
            existing.source = 'container'; // container wins as authoritative source
          }
          continue;
        }

        jobs.push(job);
        if (job.id) seen.add(job.id);
      }
    }
  }

  // 3. Enrich host-origin jobs that have agentId pointing to a known container
  //    (these were already found on host, but still tag them with containerName)
  for (const job of jobs) {
    if (!job.containerName && job.agentId && agentToContainer.has(job.agentId)) {
      job.containerName = agentToContainer.get(job.agentId);
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

export async function patchCronJob(id: string, patch: Partial<OpenClawCronJob>): Promise<CronPatchResult> {
  if (typeof patch.enabled !== 'boolean') {
    return { ok: false, error: 'Only the enabled field can be patched' };
  }

  const containerName = (patch as any).containerName;

  if (containerName) {
    const ok = toggleInContainer(containerName, id, patch.enabled);
    if (ok) return { ok: true, job: { id, enabled: patch.enabled } as OpenClawCronJob };
    return { ok: false, error: `Failed to toggle cron in container ${containerName}` };
  }

  const ok = toggleOnHost(id, patch.enabled);
  if (ok) return { ok: true, job: { id, enabled: patch.enabled } as OpenClawCronJob };
  return { ok: false, error: 'Failed to toggle cron on host gateway' };
}
