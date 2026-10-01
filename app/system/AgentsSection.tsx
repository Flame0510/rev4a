'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { formatMb, formatRate, formatSharePercent } from '@/lib/utils/format';
import { Accordion, Pill, Surface } from '../components/ui';
import { AgentCharts } from './AgentCharts';
import { SystemAgentsHeading, SystemAgentsSkeleton } from './SystemSkeleton';

const POLL_MS = 30_000;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Three sampling intervals: fresher than this, the daemon has just seen the container. */
const RECENT_S = 180;

interface ContainerRow {
  container: string;
  name: string;
  agent_id: string | null;
  is_agent: boolean;
  running: boolean;
  last_seen: number;
  now: {
    cpu_cores: number | null; cpu_percent: number | null; mem_mb: number | null; mem_percent: number | null; pids: number | null;
    net_rx_bps: number | null; net_tx_bps: number | null; blk_read_bps: number | null; blk_write_bps: number | null;
  } | null;
  range: { cpu_avg_percent: number | null; cpu_max_percent: number | null; mem_avg_mb: number | null; mem_max_mb: number | null };
  storage: { volume_mb: number | null; layer_mb: number | null; total_mb: number | null; ts: number | null };
}

interface DockerStorage {
  ts: number;
  images_mb: number | null; images_reclaimable_mb: number | null;
  build_cache_mb: number | null; build_cache_reclaimable_mb: number | null;
  volumes_mb: number; unused_volumes_mb: number; layers_mb: number;
  unused_volumes: { name: string; size_mb: number }[];
}

interface OverviewPayload {
  available: boolean;
  range: string;
  interval_s: number;
  host?: { ncpu: number; mem_total_mb: number } | null;
  sampled_at?: number | null;
  age_s?: number | null;
  containers?: ContainerRow[];
  rest?: { cpu_percent: number | null; mem_mb: number | null } | null;
  docker_storage?: DockerStorage | null;
}

function ago(ts: number): string {
  const min = Math.round((Date.now() / 1000 - ts) / 60);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function Figure({ label, value }: { label: string; value: ReactNode }) {
  return <span><span className="ui-muted">{label}</span> {value}</span>;
}

/** One cell of the Docker storage block: what it is, how much, and what of it no container uses. */
function StorageCell({ label, value, note, title }: { label: string; value: string; note?: string; title?: string }) {
  return (
    <div title={title}>
      <div className="ui-kicker">{label}</div>
      <div style={{ fontSize: 16, marginTop: 6 }}>{value}</div>
      {note && <div className="ui-muted" style={{ fontSize: 11, marginTop: 4 }}>{note}</div>}
    </div>
  );
}

/**
 * The System page's *Agents* section: one accordion per container — closed it carries the
 * numbers (CPU, memory, storage, processes), open it carries the same three charts as the
 * machine, for that container, under the page's range tabs. Above them what Docker holds on
 * disk; below them everything that is not a container, so the figures add up to the cards.
 *
 * `/system?agent=<container>` opens one accordion and scrolls to it.
 */
export function AgentsSection({
  range, span, formatTime,
}: { range: string; span: number; formatTime: (ts: number) => string }) {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string[]>([]);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  const abortRef = useRef<AbortController | null>(null);
  const scrollTo = useRef<string | null>(null);

  // A link from the agent panel: open that accordion, scroll to it once the list has loaded.
  useEffect(() => {
    const agent = new URLSearchParams(window.location.search).get('agent');
    if (agent && CONTAINER_RE.test(agent)) {
      setOpen([agent]);
      scrollTo.current = agent;
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      // Advance the displayed age even when another failed request has the same error text.
      setNowS(Math.floor(Date.now() / 1000));
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch(`/api/metrics/containers?range=${range}`, { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
        setData(body as OverviewPayload);
        setError('');
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message || 'Could not load the containers');
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [range]);

  // One attempt, on the first answer: a container that is not in the list then must not pull
  // the page down later, on a poll that happens to include it.
  useEffect(() => {
    const target = scrollTo.current;
    if (!data || !target) return;
    scrollTo.current = null;
    document.getElementById(`agent-${target}`)?.scrollIntoView({ block: 'start' });
  }, [data]);

  const toggle = (container: string) =>
    setOpen((prev) => (prev.includes(container) ? prev.filter((c) => c !== container) : [...prev, container]));

  const stale = data !== null && data.range !== range;
  const containers = data?.containers ?? [];
  const storage = data?.docker_storage ?? null;
  // Recompute age from the sample timestamp: a failed refresh must not freeze an old answer's
  // age_s at the value it had when it was fetched.
  const sampleAgeS = data?.sampled_at == null ? null : Math.max(0, nowS - data.sampled_at);
  const notCurrent = data?.available && sampleAgeS !== null && sampleAgeS > data.interval_s * 3;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SystemAgentsHeading />

      {error && !data && <Surface tone="danger"><span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span></Surface>}

      {error && data && (
        <Surface tone="warning">
          <div className="ui-kicker">Could not refresh</div>
          <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>{error}. Showing the last answer; it is tried again every {POLL_MS / 1000} s.</p>
        </Surface>
      )}

      {!data && !error && <SystemAgentsSkeleton />}

      {data && !data.available && (
        <Surface tone="warning">
          <div className="ui-kicker">No container samples yet</div>
          <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
            The Rev4a daemon records them every {data.interval_s} s once Docker answers. If this stays empty, check that rev4a serve is running and that Docker is up.
          </p>
        </Surface>
      )}

      {notCurrent && sampleAgeS !== null && (
        <Surface tone="warning">
          <div className="ui-kicker">Not collecting</div>
          <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
            The latest container sample is {Math.round(sampleAgeS / 60)} min old: the values below are not current. Check that the Rev4a daemon is running and that Docker is up.
          </p>
        </Surface>
      )}

      {data?.available && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: stale ? 0.5 : 1 }}>
          {storage && (
            <Surface as="section">
              <div className="ui-kicker">Docker storage</div>
              <div className="system-docker-storage" style={{ marginTop: 10 }}>
                <StorageCell
                  label="Images"
                  value={formatMb(storage.images_mb)}
                  note={storage.images_reclaimable_mb ? `${formatMb(storage.images_reclaimable_mb)} not used by a container` : undefined}
                  title="Images no container is running from — older agent versions you may still roll back to count here"
                />
                <StorageCell
                  label="Volumes"
                  value={formatMb(storage.volumes_mb)}
                  note={storage.unused_volumes_mb ? `${formatMb(storage.unused_volumes_mb)} not attached to a container` : undefined}
                  title={storage.unused_volumes.map((v) => `${v.name}: ${formatMb(v.size_mb)}`).join('\n') || undefined}
                />
                <StorageCell label="Writable layers" value={formatMb(storage.layers_mb)} />
                <StorageCell
                  label="Build cache"
                  value={formatMb(storage.build_cache_mb)}
                  note={storage.build_cache_reclaimable_mb ? `${formatMb(storage.build_cache_reclaimable_mb)} not in use` : undefined}
                />
              </div>
              <p className="ui-muted" style={{ fontSize: 11, marginTop: 10 }}>
                Read {ago(storage.ts)}, every 10 min.
                {storage.unused_volumes.length > 0 && ` Not attached: ${storage.unused_volumes.map((v) => `${v.name} (${formatMb(v.size_mb)})`).join(', ')}.`}
              </p>
            </Surface>
          )}

          {containers.length === 0 && (
            <Surface><p className="ui-muted" style={{ fontSize: 12 }}>No container was seen in this range.</p></Surface>
          )}

          {containers.map((c) => {
            const r = c.range;
            // Docker's list can stay fresh even when every stats call fails. Decide whether
            // the container was recently seen from its own timestamp, not the newest metrics row.
            const observed = Math.max(0, nowS - c.last_seen) <= RECENT_S;
            const current = !notCurrent && c.running ? c.now : null;
            const status = current ? null : observed ? 'no data' : notCurrent ? 'not current' : 'stopped';
            const parts = current
              ? [
                  current.cpu_cores !== null ? `${current.cpu_cores.toFixed(3)} cores` : null,
                  r.cpu_avg_percent !== null ? `CPU avg ${formatSharePercent(r.cpu_avg_percent)} · peak ${formatSharePercent(r.cpu_max_percent)}` : null,
                  r.mem_avg_mb !== null ? `Memory avg ${formatMb(r.mem_avg_mb)} · peak ${formatMb(r.mem_max_mb)}` : null,
                  current.mem_percent !== null ? `${current.mem_percent}% of Docker's memory` : null,
                  current.net_rx_bps !== null || current.net_tx_bps !== null ? `↓ ${formatRate(current.net_rx_bps)} ↑ ${formatRate(current.net_tx_bps)}` : null,
                ]
              : [`Last seen ${ago(c.last_seen)}`, r.cpu_avg_percent !== null ? `CPU avg ${formatSharePercent(r.cpu_avg_percent)} · peak ${formatSharePercent(r.cpu_max_percent)} while running` : null];
            return (
              <Accordion
                key={c.container}
                id={`agent-${c.container}`}
                open={open.includes(c.container)}
                onToggle={() => toggle(c.container)}
                title={
                  <>
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                    <Pill tone={c.is_agent ? 'accent' : 'neutral'}>{c.is_agent ? 'agent' : 'container'}</Pill>
                    {status && <Pill tone="warning">{status}</Pill>}
                    {c.name !== c.container && (
                      <span className="ui-muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono-stack)' }}>{c.container}</span>
                    )}
                  </>
                }
                summary={
                  current ? (
                    <>
                      <Figure label="CPU" value={formatSharePercent(current.cpu_percent)} />
                      <Figure label="Memory" value={formatMb(current.mem_mb)} />
                      <Figure label="Storage" value={formatMb(c.storage.total_mb)} />
                      <Figure label="PIDs" value={current.pids ?? '—'} />
                    </>
                  ) : (
                    <Figure label="Storage" value={formatMb(c.storage.total_mb)} />
                  )
                }
                detail={parts.filter(Boolean).join(' · ')}
              >
                <AgentCharts container={c.container} range={range} span={span} formatTime={formatTime} />
              </Accordion>
            );
          })}

          {data.rest && containers.length > 0 && (
            <Surface>
              <div className="ui-key-value" style={{ fontSize: 12 }}>
                <span>Everything else <span className="ui-muted">· the host, Rev4a and other software</span></span>
                <span>
                  <Figure label="CPU" value={formatSharePercent(data.rest.cpu_percent)} />
                  {'  '}
                  <Figure label="Memory" value={formatMb(data.rest.mem_mb)} />
                </span>
              </div>
            </Surface>
          )}
        </div>
      )}
    </section>
  );
}
