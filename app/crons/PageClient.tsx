'use client';

import { useEffect, useState } from 'react';
import { useResponsive } from '../design-system';
import { Button, Pill } from '../components/ui';
import { SkeletonLines } from '../components/Skeleton';
import { apiFetch } from '@/lib/apiFetch';
import { useOlympusTimezone } from '@/lib/hooks/useOlympusTimezone';
import { formatDateTimeInTimezone } from '@/lib/timezone';


interface CronSchedule { kind?: string; expr?: string; tz?: string; [k: string]: unknown }
interface CronPayload { kind?: string; message?: string; model?: string; [k: string]: unknown }
interface CronState { lastStatus?: string; nextRunAtMs?: number | null; lastRunAtMs?: number | null; [k: string]: unknown }
interface CronDelivery { mode?: string; channel?: string; to?: string; [k: string]: unknown }

interface CronJob {
  id?: string;
  name?: string;
  description?: string;
  agentId?: string;
  containerName?: string;
  sessionKey?: string;
  sessionTarget?: string;
  wakeMode?: string;
  schedule?: CronSchedule | string;
  scheduleExpr?: string;
  computedNextRunAtMs?: number | null;
  payload?: CronPayload;
  delivery?: CronDelivery;
  state?: CronState;
  enabled?: boolean;
  createdAtMs?: number;
  source?: 'host' | 'container';
  [key: string]: unknown;
}

interface CronRunEntry {
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
  usage?: Record<string, number>;
  diagnostics?: { summary?: string; entries?: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

function formatTs(ms: number, timezone: string): string {
  return formatDateTimeInTimezone(ms, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false,
  }, timezone);
}

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return '';
  const [min, hour, dom, month, dow] = parts;

  const every = (f: string) => f === '*' || f === '*/1';
  const everyN = (f: string) => f.startsWith('*/');
  const fixed = (f: string) => /^\d+$/.test(f);

  if (every(min) && every(hour) && every(dom) && every(month) && every(dow))
    return 'ogni minuto';

  if (everyN(min) && every(hour) && every(dom) && every(month) && every(dow)) {
    const n = min.split('/')[1];
    return `ogni ${n} minut${n === '1' ? 'o' : 'i'}`;
  }

  if (fixed(min) && every(hour) && every(dom) && every(month) && every(dow))
    return min === '0' ? 'ogni ora' : `ogni ora al minuto ${min}`;

  if (everyN(hour) && every(dom) && every(month) && every(dow)) {
    const n = hour.split('/')[1];
    const suffix = fixed(min) && min !== '0' ? ` al minuto ${min}` : '';
    return `ogni ${n} ore${suffix}`;
  }

  if (fixed(min) && fixed(hour) && every(dom) && every(month) && every(dow)) {
    const h = hour.padStart(2, '0'), m = min.padStart(2, '0');
    return `ogni giorno alle ${h}:${m}`;
  }

  if (fixed(min) && fixed(hour) && every(dom) && every(month) && fixed(dow)) {
    const days = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
    const d = days[parseInt(dow)] ?? dow;
    const h = hour.padStart(2, '0'), m = min.padStart(2, '0');
    return `ogni settimana (${d}) alle ${h}:${m}`;
  }

  if (fixed(min) && fixed(hour) && fixed(dom) && every(month) && every(dow)) {
    const h = hour.padStart(2, '0'), m = min.padStart(2, '0');
    return `il giorno ${dom} di ogni mese alle ${h}:${m}`;
  }

  return '';
}

// ── Agent filter helpers ──────────────────────────────────────────────────

interface AgentFilter {
  key: string;       // 'all' | 'host' | containerName
  label: string;     // 'ALL' | 'HOST' | agentId
  source: string;    // 'all' | 'host' | 'container'
  containerName?: string;
}

function buildAgentFilters(jobs: CronJob[]): AgentFilter[] {
  const seen = new Set<string>();
  const filters: AgentFilter[] = [{ key: 'all', label: 'ALL', source: 'all' }];

  for (const job of jobs) {
    if (job.source === 'host' && !seen.has('host')) {
      seen.add('host');
      filters.push({ key: 'host', label: 'HOST', source: 'host' });
    }
    if (job.containerName && !seen.has(job.containerName)) {
      seen.add(job.containerName);
      filters.push({
        key: job.containerName,
        label: job.agentId ?? job.containerName,
        source: 'container',
        containerName: job.containerName,
      });
    }
  }
  return filters;
}

function filterJobs(jobs: CronJob[], agentKey: string): CronJob[] {
  if (agentKey === 'all') return jobs;
  if (agentKey === 'host') return jobs.filter(j => j.source === 'host');
  return jobs.filter(j => j.containerName === agentKey);
}


export default function CronsPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState('all');
  const [selectedJob, setSelectedJob] = useState<CronJob | null>(null);
  const [runs, setRuns] = useState<CronRunEntry[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const isMobile = useResponsive('lg');
  const [tab, setTab] = useState<'jobs' | 'runs'>('jobs');
  const timezone = useOlympusTimezone();

  const agentFilters = buildAgentFilters(jobs);
  const filteredJobs = filterJobs(jobs, agentFilter);

  async function toggleJob(job: CronJob) {
    const id = job.id;
    if (!id) return;
    setToggling(id);
    try {
      const body: Record<string, unknown> = { enabled: !(job.enabled !== false) };
      if (job.containerName) body.containerName = job.containerName;
      const res = await apiFetch(`/api/crons/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const updated = await res.json() as CronJob;
        setJobs((prev) => prev.map((j) => j.id === id ? { ...j, ...updated } : j));
      }
    } catch { /* keep UI alive */ }
    finally { setToggling(null); }
  }

  async function loadRuns(job: CronJob) {
    if (!job.id || !job.containerName) return;
    setRunsLoading(true);
    setRunsError(null);
    setRuns([]);
    try {
      const res = await apiFetch(
        `/api/crons/runs?containerName=${encodeURIComponent(job.containerName)}&jobId=${encodeURIComponent(job.id)}&limit=30`
      );
      if (res.ok) {
        const data = await res.json();
        setRuns((data.entries ?? []) as CronRunEntry[]);
      } else {
        setRunsError('Failed to load runs');
      }
    } catch {
      setRunsError('Failed to load runs');
    } finally {
      setRunsLoading(false);
    }
  }

  async function load() {
    try {
      const jobsRes = await apiFetch('/api/crons');
      if (jobsRes.ok) {
        const data = await jobsRes.json() as CronJob[] | { jobs: CronJob[] };
        setJobs(Array.isArray(data) ? data : (data.jobs ?? []));
      }
    } catch { /* keep UI alive */ }
    finally { setLoading(false); }
  }

  // Load runs when a job is selected
  useEffect(() => {
    if (selectedJob) void loadRuns(selectedJob);
  }, [selectedJob?.id, selectedJob?.containerName]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="crons-page">
      <div className="crons-header">
        <span className="crons-header__title">CRONS</span>
        <span className="crons-header__meta">{runs.length} runs loaded</span>
      </div>

      {loading && <SkeletonLines count={4} />}

      {/* Agent filter bar */}
      {agentFilters.length > 1 && (
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          {agentFilters.map((af) => (
            <Button
              key={af.key}
              variant={agentFilter === af.key ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setAgentFilter(af.key)}
            >
              {af.label} ({filterJobs(jobs, af.key).length})
            </Button>
          ))}
        </div>
      )}

      {isMobile && (
        <div className="crons-mobile-tabs">
          <Button variant={tab === 'jobs' ? 'primary' : 'ghost'} size="sm" onClick={() => setTab('jobs')}>JOBS</Button>
          <Button variant={tab === 'runs' ? 'primary' : 'ghost'} size="sm" onClick={() => setTab('runs')}>RUNS</Button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: isMobile ? 'column' : 'row', minHeight: 0, overflow: 'hidden' }}>
        {/* Scheduled jobs */}
        <section style={{ width: isMobile ? '100%' : '40%', borderRight: isMobile ? 'none' : '1px solid var(--border)', display: isMobile && tab !== 'jobs' ? 'none' : 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 10, color: '#555', flexShrink: 0 }}>
            SCHEDULED JOBS ({filteredJobs.length})
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filteredJobs.length === 0 && !loading && (
              <div style={{ padding: '20px 12px', fontSize: 11, color: '#555' }}>No scheduled jobs found</div>
            )}
            {filteredJobs.map((job, i) => {
              const expr = job.scheduleExpr
                ?? (typeof job.schedule === 'string' ? job.schedule : (job.schedule as CronSchedule | undefined)?.expr ?? '');
              const tz = typeof job.schedule === 'object' && job.schedule !== null
                ? (job.schedule as CronSchedule).tz : undefined;
              const model = job.payload?.model;
              const prompt = job.payload?.message ?? (job.payload as { text?: string } | undefined)?.text;
              const nextRun = job.computedNextRunAtMs ?? job.state?.nextRunAtMs;
              const lastRun = job.state?.lastRunAtMs;
              const lastStatus = job.state?.lastStatus;
              const isEnabled = job.enabled !== false;
              const isContainered = job.source === 'container' && !!job.containerName;
              const isSelected = selectedJob?.id === job.id;
              return (
                <div 
                  key={job.id ?? i} 
                  onClick={() => setSelectedJob(isSelected ? null : job)}
                  style={{
                  padding: '12px 14px', borderBottom: '1px solid var(--border)',
                  opacity: isEnabled ? 1 : 0.6,
                  cursor: 'pointer',
                  background: isSelected ? 'var(--copper-bg)' : 'transparent',
                  borderLeft: isSelected ? '2px solid var(--copper)' : '2px solid transparent',
                  transition: 'background 0.15s, border-color 0.15s',
                }}>
                  {/* Header row */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: 'var(--copper)', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job.name ?? job.id ?? `job-${i}`}
                      </div>
                      {job.description && (
                        <div style={{ fontSize: 10, color: '#888', marginTop: 2, lineHeight: 1.4 }}>{String(job.description)}</div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {isContainered && (
                        <span style={{ fontSize: 9 }}><Pill tone="success">{job.containerName ?? job.agentId ?? 'agent'}</Pill></span>
                      )}
                      {job.id && (
                        <button
                          onClick={() => void toggleJob(job)}
                          disabled={toggling === job.id}
                          title={isEnabled ? 'Disable job' : 'Enable job'}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 5,
                            padding: '3px 8px 3px 5px',
                            border: `1px solid ${isEnabled ? '#255b3f' : 'var(--border)'}`,
                            borderRadius: 0,
                            background: isEnabled ? 'rgba(34,197,94,0.08)' : 'var(--bg2)',
                            cursor: toggling === job.id ? 'not-allowed' : 'pointer',
                            opacity: toggling === job.id ? 0.5 : 1,
                            transition: 'all 0.15s', outline: 'none',
                          }}
                        >
                          <span style={{
                            display: 'inline-flex', width: 26, height: 14, borderRadius: 0,
                            background: toggling === job.id ? '#555' : isEnabled ? 'var(--green)' : '#3a3a3a',
                            alignItems: 'center', padding: '0 2px',
                            justifyContent: isEnabled ? 'flex-end' : 'flex-start',
                            transition: 'all 0.15s', flexShrink: 0,
                          }}>
                            <span style={{ width: 10, height: 10, borderRadius: 1, background: '#fff' }} />
                          </span>
                          <span style={{ fontSize: 9, letterSpacing: '0.07em', color: isEnabled ? 'var(--green)' : '#666' }}>
                            {toggling === job.id ? '···' : isEnabled ? 'ON' : 'OFF'}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Schedule */}
                  {expr && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: '#555' }}>schedule</span>
                      <span style={{ fontSize: 11, color: '#60a5fa', fontFamily: 'monospace' }}>{expr}</span>
                      {tz && <span style={{ fontSize: 10, color: '#555' }}>{tz}</span>}
                      {describeCron(expr) && (
                        <span style={{ fontSize: 10, color: '#a3a3a3', fontStyle: 'italic' }}>({describeCron(expr)})</span>
                      )}
                    </div>
                  )}

                  {/* Timing grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 6 }}>
                    {nextRun != null && (
                      <div>
                        <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.06em', marginBottom: 1 }}>NEXT RUN</div>
                        <div style={{ fontSize: 11, color: isEnabled ? '#22c55e' : '#666' }}>{formatTs(nextRun, timezone)}</div>
                      </div>
                    )}
                    {lastRun != null && (
                      <div>
                        <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.06em', marginBottom: 1 }}>LAST RUN</div>
                        <div style={{ fontSize: 11, color: '#888' }}>{formatTs(lastRun, timezone)}</div>
                      </div>
                    )}
                    {job.createdAtMs != null && (
                      <div>
                        <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.06em', marginBottom: 1 }}>CREATED</div>
                        <div style={{ fontSize: 11, color: '#888' }}>{formatTs(job.createdAtMs as number, timezone)}</div>
                      </div>
                    )}
                    {lastStatus && (
                      <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                        <Pill tone={lastStatus === 'ok' ? 'success' : lastStatus === 'error' ? 'danger' : 'neutral'}>{lastStatus.toUpperCase()}</Pill>
                      </div>
                    )}
                  </div>

                  {/* Meta row */}
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, color: '#555', borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 2 }}>
                    {job.source === 'host' && <span>source: <span style={{ color: '#888' }}>host (gateway)</span></span>}
                    {isContainered && <span>container: <span style={{ color: '#888' }}>{String(job.containerName)}</span></span>}
                    {model && <span>model: <span style={{ color: '#888' }}>{String(model)}</span></span>}
                    {job.sessionTarget && <span>target: <span style={{ color: '#888' }}>{String(job.sessionTarget)}</span></span>}
                    {job.delivery?.channel && <span>→ <span style={{ color: '#888' }}>{String(job.delivery.channel)}</span></span>}
                    {job.id && <span style={{ color: '#444', marginLeft: 'auto' }}>{String(job.id).slice(0, 8)}</span>}
                  </div>

                  {/* Prompt preview */}
                  {prompt && (
                    <div style={{ fontSize: 10, color: '#444', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: 'italic' }}>
                      &ldquo;{String(prompt).slice(0, 120)}{String(prompt).length > 120 ? '…' : ''}&rdquo;
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Cron run history */}
        <section style={{ flex: 1, display: isMobile && tab !== 'runs' ? 'none' : 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 10, color: '#555', flexShrink: 0 }}>
            RUN HISTORY {selectedJob ? `— ${selectedJob.name ?? selectedJob.id?.slice(0, 8) ?? ''}` : ''}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {!selectedJob && !loading && (
              <div style={{ padding: '20px 12px', fontSize: 11, color: '#555' }}>Select a cron job to view its run history</div>
            )}
            {selectedJob && runsLoading && <SkeletonLines count={3} />}
            {selectedJob && !runsLoading && runsError && (
              <div style={{ padding: '20px 12px', fontSize: 11, color: 'var(--red)' }}>{runsError}</div>
            )}
            {selectedJob && !runsLoading && !runsError && runs.length === 0 && (
              <div style={{ padding: '20px 12px', fontSize: 11, color: '#555' }}>No runs recorded yet</div>
            )}
            {selectedJob && !runsLoading && runs
              .slice()
              .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
              .map((r) => {
                const ts = r.ts ?? 0;
                const status = r.status ?? 'unknown';
                const action = r.action ?? '';
                const dur = r.durationMs;
                const runId = r.runId?.slice(-12) ?? '';
                const error = r.error ?? r.diagnostics?.summary;
                return (
                  <div key={r.runId ?? ts} style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: 1,
                        background: status === 'ok' ? 'var(--green)' : status === 'error' ? 'var(--red)' : 'var(--yellow)',
                        display: 'inline-block', flexShrink: 0,
                      }} />
                      <span style={{ fontSize: 10, color: 'var(--copper)', letterSpacing: '0.06em' }}>
                        {action.toUpperCase()}
                      </span>
                      <Pill tone={status === 'ok' ? 'success' : status === 'error' ? 'danger' : 'neutral'}>
                        {status.toUpperCase()}
                      </Pill>
                      {dur != null && (
                        <span style={{ fontSize: 10, color: '#555', marginLeft: 'auto' }}>
                          {dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: '#555', marginBottom: error ? 4 : 0 }}>
                      {formatTs(ts, timezone)}{runId ? ` · #${runId}` : ''}
                    </div>
                    {error && (
                      <div style={{
                        fontSize: 9, color: 'var(--red)',
                        padding: '4px 6px', background: 'rgba(239,68,68,0.06)',
                        marginTop: 2, maxHeight: 50, overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {String(error).slice(0, 180)}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      </div>
    </div>
  );
}
