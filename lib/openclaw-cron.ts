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
  // Strategy 1: OpenClaw CLI via known gateway ports
  // The gateway may run on a non-default port (e.g. 3000 instead of 18789).
  // Try $OPENCLAW_GATEWAY_URL first, then common ports (3000, 18789).
  const gatewayUrls = [
    `http://127.0.0.1:3000`,
    `http://127.0.0.1:18789`,
  ];

  for (const gwUrl of gatewayUrls) {
    try {
      const raw = execFileSync('docker', ['exec', '-e', `OPENCLAW_GATEWAY_URL=${gwUrl}`, containerName, 'openclaw', 'cron', 'list', '--json'], {
        encoding: 'utf8', timeout: 15000,
      });
      const parsed = parseCronListOutput(raw);
      if (parsed) return parsed;
    } catch { /* try next gateway port */ }
  }

  // Strategy 2: read ~/.openclaw/cron/jobs.json directly (gateway not reachable)
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

// ── List: per-container cron only (AGENT_ID containers) ────────────────

export async function listOpenClawCronJobs(): Promise<OpenClawCronListResult> {
  const seen = new Set<string>();
  const jobs: OpenClawCronJob[] = [];

  // Only discover cron jobs from containers with AGENT_ID label
  const agents = discoverAgentContainers();

  for (const agent of agents) {
    const containerJobs = listJobsInContainer(agent.containerName);
    if (containerJobs) {
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
