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

export function discoverAgentContainers(): AgentInfo[] {
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

// ── Read all cron jobs from the host gateway ────────────────────────────

export async function listOpenClawCronJobs(): Promise<OpenClawCronListResult> {
  try {
    // Use openclaw CLI on the host to get all cron jobs
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], {
      encoding: 'utf8', timeout: 15000,
    });

    const parsed = JSON.parse(raw.trim()) as unknown;
    let jobs: OpenClawCronJob[] = [];

    if (Array.isArray(parsed)) {
      jobs = parsed as OpenClawCronJob[];
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { jobs?: unknown[] }).jobs)) {
      jobs = (parsed as { jobs: OpenClawCronJob[] }).jobs;
    }

    // Normalize: ensure scheduleExpr is present
    for (const job of jobs) {
      job.scheduleExpr = extractScheduleExpr(job);
    }

    // Enrich with containerName from agent containers
    const agents = discoverAgentContainers();
    const agentToContainer = new Map(agents.map(a => [a.agentId, a.containerName]));

    for (const job of jobs) {
      if (job.agentId && agentToContainer.has(job.agentId)) {
        job.containerName = agentToContainer.get(job.agentId);
      }
    }

    return { ok: true, jobs, total: jobs.length };
  } catch (e) {
    return {
      ok: false,
      jobs: [],
      total: 0,
    };
  }
}

// ── Patch a cron job via openclaw CLI ───────────────────────────────────

export interface CronPatchResult {
  ok: boolean;
  job?: OpenClawCronJob;
  error?: string;
}

export async function patchCronJob(id: string, patch: Partial<OpenClawCronJob>): Promise<CronPatchResult> {
  if (typeof patch.enabled !== 'boolean') {
    return { ok: false, error: 'Only the enabled field can be patched' };
  }

  const action = patch.enabled ? 'enable' : 'disable';

  try {
    execFileSync('openclaw', ['cron', action, id], {
      encoding: 'utf8', timeout: 10000,
    });
    return { ok: true, job: { id, enabled: patch.enabled } as OpenClawCronJob };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
