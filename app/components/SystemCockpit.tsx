'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Costs, FilterConfig, Session, SessionEvent } from '@/lib/types';
import { isSessionActive } from '@/lib/patterns/sessionPresentation';
import { SkeletonLines, SkeletonMetric } from './Skeleton';
import { Metric, StatusCard, Surface, meterLevel, toneFromHealth, type MeterLevel, type Tone } from './ui';
import { apiFetch } from '@/lib/apiFetch';
import LiveFeed from './LiveFeed';
import CostBreakdown from './CostBreakdown';

interface SystemCheck {
  id: string;
  label: string;
  health: 'ok' | 'warning' | 'error';
  value: string | number;
  details?: string;
  source: 'runtime' | 'memory' | 'cron' | 'cost' | 'trello';
}

interface Recommendation {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  source: SystemCheck['source'];
  title: string;
  details: string;
  actionHref?: string;
  dismissible: boolean;
  createdAt: string;
  trelloCardId?: string;
}

interface SystemHealthPayload {
  health: 'ok' | 'warning' | 'error';
  checks: SystemCheck[];
  recommendations: Recommendation[];
  generatedAt: string;
}

interface MachineNow {
  cpu: number | null;
  ram: number | null;
  disk: number | null;
  /** `empty`: no sample yet; `stale`: the newest is older than 3 intervals; `error`: the last refresh failed (figures are the previous ones). */
  state: 'ok' | 'empty' | 'stale' | 'error';
}

const LEVEL_TONE: Record<MeterLevel, Tone> = { ok: 'neutral', warning: 'warning', critical: 'danger' };

/** The host machine right now (CPU, RAM, fullest disk) from /api/metrics; details on /system. */
function useMachineNow(): MachineNow | null {
  const [now, setNow] = useState<MachineNow | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const load = () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      apiFetch('/api/metrics?range=1h', { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          const l = d.latest;
          if (!l) { setNow({ cpu: null, ram: null, disk: null, state: 'empty' }); return; }
          const disks: { percent: number }[] = l.disks ?? [];
          setNow({
            cpu: l.cpu === null ? null : Math.round(l.cpu),
            ram: l.ram_total_mb ? Math.round((l.ram_used_mb / l.ram_total_mb) * 100) : null,
            disk: disks.length ? Math.max(...disks.map((x) => x.percent)) : null,
            state: l.age_s > d.interval_s * 3 ? 'stale' : 'ok',
          });
        })
        .catch((e) => {
          if (e?.name === 'AbortError') return;
          setNow((prev) => ({ cpu: prev?.cpu ?? null, ram: prev?.ram ?? null, disk: prev?.disk ?? null, state: 'error' }));
        });
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { clearInterval(t); abortRef.current?.abort(); };
  }, []);
  return now;
}

interface SystemCockpitProps {
  sessions: Session[];
  events: SessionEvent[];
  costs: Costs;
  filter: FilterConfig;
  visibleEvents: SessionEvent[];
  loading?: boolean;
}

function fmtMoney(value?: number | null): string {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

function fmtAge(ts?: number | null): string {
  if (!ts) return 'n/a';
  const ms = Date.now() - (ts > 10_000_000_000 ? ts : ts * 1000);
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function severityHealth(severity: Recommendation['severity']): 'ok' | 'warning' | 'error' | 'info' {
  if (severity === 'critical') return 'error';
  if (severity === 'warning') return 'warning';
  return 'info';
}

function findCheck(checks: SystemCheck[], id: string): SystemCheck | undefined {
  return checks.find((check) => check.id === id);
}

export default function SystemCockpit({
  sessions, events, costs, filter, visibleEvents,
  loading = false,
}: SystemCockpitProps) {
  const [systemHealth, setSystemHealth] = useState<SystemHealthPayload | null>(null);
  const machine = useMachineNow();

  useEffect(() => {
    const load = () => {
      apiFetch('/api/system-health')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(setSystemHealth)
        .catch((error) => setSystemHealth({
          health: 'warning',
          checks: [{ id: 'system-health.api', label: 'System health API', health: 'warning', value: 'warning', details: error.message, source: 'runtime' }],
          recommendations: [{ id: 'system-health.api', severity: 'warning', source: 'runtime', title: 'System health unreadable', details: error.message, dismissible: false, createdAt: new Date().toISOString() }],
          generatedAt: new Date().toISOString(),
        }));
    };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const metrics = useMemo(() => {
    // Working sessions across all the agent containers (OpenClaw's own status).
    const working = sessions.filter(isSessionActive);
    const active = working.length;
    const agentsWorking = new Set(working.map((session) => session.container)).size;
    const errors = events.filter((event) => String(event.type ?? event.event ?? '').toLowerCase().includes('error')).length;
    const latest = Math.max(...sessions.map((session) => Number(session.updated_at ?? session.started_at ?? 0)), 0);
    return { active, agentsWorking, errors, latest };
  }, [sessions, events]);

  const systemLoading = loading || !systemHealth;
  const checks = systemHealth?.checks ?? [];
  const cronCheck = findCheck(checks, 'cron.jobs') ?? findCheck(checks, 'cron.api');
  const runtimeCheck = findCheck(checks, 'runtime.sessions');
  const costCheck = findCheck(checks, 'cost.usageBasedToday');
  const health = systemHealth?.health ?? 'warning';
  const recommendations = systemHealth?.recommendations ?? [];
  const runtimeFreshness = runtimeCheck?.details ?? fmtAge(metrics.latest);
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
  // Each figure with its level, on the thresholds the System page uses (CPU/RAM 85/95, disk 80/90).
  const machineItems: { name: string; value: number | null; level: MeterLevel }[] = machine
    ? [
        { name: 'CPU', value: machine.cpu, level: machine.cpu === null ? 'ok' : meterLevel(machine.cpu, 85, 95) },
        { name: 'RAM', value: machine.ram, level: machine.ram === null ? 'ok' : meterLevel(machine.ram, 85, 95) },
        { name: 'Disk', value: machine.disk, level: machine.disk === null ? 'ok' : meterLevel(machine.disk, 80, 90) },
      ]
    : [];
  const machineIssues = machineItems.filter((i) => i.level !== 'ok');
  const machineTone: Tone = machine && machine.state !== 'ok'
    ? 'warning'
    : LEVEL_TONE[machineIssues.some((i) => i.level === 'critical') ? 'critical' : machineIssues.length ? 'warning' : 'ok'];

  return (
    <section className="cockpit">
      <div className="cockpit__metrics">
        <Surface as="article" tone={toneFromHealth(health)}>
          <div className="ui-kicker">Rev4a System Health</div>
          <div className="cockpit__health-row">
            {systemLoading ? <SkeletonMetric width={120} /> : <span className={`cockpit__health cockpit__health--${health}`}>{health}</span>}
            <span className="ui-muted" style={{ fontSize: 11 }}>{runtimeFreshness}</span>
          </div>
          <div className="ui-muted" style={{ marginTop: 10, fontSize: 11 }}>Server-side monitor from `/api/system-health`.</div>
        </Surface>
        <Metric title="Active sessions" value={metrics.active} subtitle={`${metrics.active ? `in ${metrics.agentsWorking} agent${metrics.agentsWorking === 1 ? '' : 's'} · ` : ''}${sessions.length} total`} loading={loading} />
        {/* A Surface, not a Metric: a danger Metric paints its whole value red, and only the
            figure past its threshold should be. */}
        <Surface as="article" tone={machineTone}>
          <div className="ui-kicker">Machine</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, marginTop: 14, fontSize: 15, fontWeight: 700 }}>
            {machineItems.length ? machineItems.map((i) => (
              <span key={i.name} className={`cockpit__machine-item cockpit__machine-item--${i.level}`}>{i.name} {pct(i.value)}</span>
            )) : '—'}
          </div>
          <div className="ui-muted ui-metric-subtitle">
            {machine?.state === 'error'
              ? 'Metrics unavailable. '
              : machine?.state === 'empty'
                ? 'No samples yet. '
                : machine?.state === 'stale'
                  ? 'Not collecting. '
                  : machineIssues.length
                    ? `${machineIssues.map((i) => `${i.name} ${i.level === 'critical' ? 'critical' : 'high'}`).join(', ')}. `
                    : ''}
            <Link href="/system" className="ui-link">Open System →</Link>
          </div>
        </Surface>
        <Metric title="Spent today" value={String(costCheck?.value ?? fmtMoney(costs.today))} subtitle={costCheck?.details ?? 'Priced by the agents\' OpenClaw, UTC day'} tone="accent" loading={systemLoading} />
      </div>

      <div className="cockpit__main">
        <div className="cockpit__checks">
          <StatusCard loading={systemLoading} title="Runtime Rev4a" health={runtimeCheck?.health ?? 'warning'} rows={[[runtimeCheck?.label ?? 'Total sessions', runtimeCheck?.value ?? sessions.length], ['Last update', runtimeFreshness], ['Recent feed errors', metrics.errors]]} />
          <StatusCard loading={systemLoading} title="Cron / Watchdog" health={cronCheck?.health ?? 'warning'} rows={[[cronCheck?.label ?? 'Cron', cronCheck?.value ?? 'n/a'], ['Detail', cronCheck?.details ?? 'n/a'], ['Source', '/api/system-health']]} />
          <StatusCard loading={loading} title="Lineage" health={sessions.length ? 'ok' : 'warning'} rows={[[ 'Total sessions', sessions.length], ['Live events', events.length], ['Full view', <Link key="lineage" href="/lineage" className="ui-link">Open graph →</Link>]]} />
        </div>

        <Surface as="aside">
          <div className="ui-kicker ui-kicker--accent" style={{ marginBottom: 14 }}>Recommended actions</div>
          {systemLoading ? (
            <SkeletonLines count={5} />
          ) : recommendations.length ? (
            <ul className="cockpit__recommendations">
              {recommendations.map((item) => (
                <li key={item.id} className={`cockpit__recommendation cockpit__recommendation--${severityHealth(item.severity)}`}>
                  <div className="cockpit__recommendation-head">
                    <strong>{item.title}</strong>
                    <span>{item.severity}</span>
                  </div>
                  <div className="ui-muted" style={{ marginTop: 4 }}>{item.details}</div>
                  {item.actionHref && <Link href={item.actionHref} className="ui-link" style={{ display: 'inline-block', marginTop: 6 }}>Open →</Link>}
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ color: 'var(--green)', fontSize: 13 }}>No immediate warnings. System in operational state.</div>
          )}
          <div className="cockpit__quick-links">
            <Link className="agent-btn" href="/memory">Memory</Link>
            <Link className="agent-btn" href="/crons">Crons</Link>
            <Link className="agent-btn" href="/agents">Agents</Link>
            <Link className="agent-btn" href="/lineage">Lineage</Link>
          </div>
        </Surface>
      </div>

      <div className="cockpit__feed-section">
        <LiveFeed events={visibleEvents.slice(0, 10)} loading={loading} />
        <CostBreakdown byModel={costs.byModel} loading={loading} />
      </div>
    </section>
  );
}
