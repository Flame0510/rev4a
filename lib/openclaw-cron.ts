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

function listJobsOnHost(): OpenClawCronJob[] | null {
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json', '--all'], {
      encoding: 'utf8', timeout: 15000,
    });
    return parseCronListOutput(raw);
  } catch {
    return null;
  }
}

function listJobsInContainer(containerName: string): OpenClawCronJob[] | null {
  // Try both common agent gateway ports. Agents default to 3000 (OpenClaw
  // gateway --bind lan --port 3000) but may also run on 18789 (default).
  const gatewayUrls = [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:18789',
  ];

  for (const gwUrl of gatewayUrls) {
    try {
      const raw = execFileSync('docker', [
        'exec', '-e', `OPENCLAW_GATEWAY_URL=${gwUrl}`,
        containerName, 'openclaw', 'cron', 'list', '--json', '--all',
      ], { encoding: 'utf8', timeout: 15000 });
      const parsed = parseCronListOutput(raw);
      if (parsed) return parsed;
    } catch { /* try next gateway port */ }
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
      execFileSync('docker', [
        'exec', '-e', `OPENCLAW_GATEWAY_URL=${gwUrl}`,
        containerName, 'openclaw', 'cron', action, jobId,
      ], { encoding: 'utf8', timeout: 10000 });
      return true;
    } catch { /* try next gateway port */ }
  }
  return false;
}

// ── List: host gateway + per-container cron ─────────────────────────────

export function listOpenClawCronJobs(): OpenClawCronListResult {
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

  // 2. Agent container cron jobs
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
      const raw = execFileSync('docker', [
        'exec', '-e', `OPENCLAW_GATEWAY_URL=${gwUrl}`,
        containerName, 'openclaw', 'cron', 'runs', '--id', jobId,
        '--limit', String(limit),
      ], { encoding: 'utf8', timeout: 15000 });

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
    return { ok: false, error: `Failed to toggle cron in container ${containerName}` };
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
      execFileSync('docker', [
        'exec', '-e', `OPENCLAW_GATEWAY_URL=${gwUrl}`,
        containerName, 'openclaw', 'cron', 'remove', jobId,
      ], { encoding: 'utf8', timeout: 10000 });
      return true;
    } catch { /* try next gateway port */ }
  }
  return false;
}

export function removeCronJob(id: string, containerName?: string): CronRemoveResult {
  if (containerName) {
    const ok = removeInContainer(containerName, id);
    if (ok) return { ok: true };
    return { ok: false, error: `Failed to remove cron job in container ${containerName}` };
  }

  const ok = removeOnHost(id);
  if (ok) return { ok: true };
  return { ok: false, error: 'Failed to remove cron job on host gateway' };
}
