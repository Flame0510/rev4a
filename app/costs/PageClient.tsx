'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { formatCost } from '@/lib/utils/format';
import { useRev4aTimezone } from '@/lib/hooks/useRev4aTimezone';
import { Meter, Page, PageHeader, Pill, Surface, Tabs, TimeSeriesChart } from '../components/ui';
import { COSTS_DESCRIPTION, CostsBodySkeleton, CostsCardsSkeleton } from './CostsSkeleton';

type Range = 'today' | '7d' | '30d';
const RANGES: { id: Range; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];
/** The daemon reads the agents every 5 min; a minute keeps the page close behind it. */
const POLL_MS = 60_000;
const DAY_S = 86_400;

interface Totals {
  cost: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number; missing: number;
}
interface AgentRow {
  container: string; agentId: string | null; name: string | null; cost: number; tokens: number; missing: number;
  collectedAt: number | null; attemptedAt: number | null; error: string | null;
}
interface ModelRow { provider: string; model: string; cost: number; tokens: number; calls: number }
interface SessionRow {
  container: string; sessionId: string; sessionKey: string | null; label: string | null; agentName: string | null;
  model: string | null; cost: number; tokens: number; missing: number; lastActivity: number | null;
}
interface CostsPayload {
  available: boolean;
  range: Range;
  startDate: string;
  endDate: string;
  intervalS: number;
  pricing: { vendor: string; band: 'peak' | 'off-peak' | null; nextChange: number | null; source: string } | null;
  totals: Totals;
  daily: { date: string; cost: number; tokens: number; missing: number }[];
  byAgent: AgentRow[];
  byModel: ModelRow[];
  sessions: SessionRow[];
  unpriced: { model: string; calls: number; agents: string[] }[];
  reconciliation: Reconciliation[];
  proxy: ProxyUsage;
}
interface ProxyAgentRow {
  agent: string; calls: number; promptTokens: number; completionTokens: number; cachedTokens: number;
  errors: number; noUsage: number; cost: number;
}
interface AgentMetering {
  key: string; container: string | null; agentId: string | null; name: string | null;
  recorded: number; recordedTokens: number; metered: ProxyAgentRow | null;
  combined: number; gap: number; flagged: boolean;
}
interface ProxyUsage {
  available: boolean; byAgent: AgentMetering[]; recordedCost: number; meteredCost: number; combinedCost: number;
}
interface Reconciliation {
  vendor: string; currency: string | null; from: number | null; to: number | null;
  billed: number | null; priced: number | null; topUps: number; readings: number; comparable: boolean;
}

/** What the proxy calls callers that are not agents. */
const PROXY_CALLER_LABEL: Record<string, string> = {
  unknown: 'Unidentified callers',
  assistant: 'Rev4a assistant',
};

const VENDOR_LABEL: Record<string, string> = { deepseek: 'DeepSeek', openrouter: 'OpenRouter' };


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
const utcDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const utcTime = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** A breakdown row: name and figure, a share meter, and a muted detail line. */
function BreakdownRow({ name, figure, detail, percent, label }: { name: string; figure: string; detail: string; percent: number; label: string }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div className="ui-key-value" style={{ fontSize: 12 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span>{figure}</span>
      </div>
      <Meter percent={percent} level="ok" label={label} />
      <div className="ui-muted" style={{ fontSize: 11, marginTop: 4 }}>{detail}</div>
    </div>
  );
}

export default function CostsPageClient() {
  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<CostsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const timeZone = useRev4aTimezone();

  const load = useCallback(async (r: Range) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/costs/usage?range=${r}`, { signal: controller.signal });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      setData(body as CostsPayload);
      setError('');
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setError(e?.message || 'Could not load the costs');
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
    const timer = setInterval(() => load(range), POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [range, load]);

  const firstLoad = data === null && !error;
  const stale = loading && data !== null && data.range !== range;
  const now = Date.now();
  const t = data?.totals;
  const sessionTime = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone });

  // Agents the daemon is still trying to read (a recent attempt) whose figures are not
  // current. A stopped or deleted agent is no longer attempted and keeps its last figures
  // on purpose: it is not flagged.
  const interval = (data?.intervalS ?? 300) * 1000;
  const lagging = (data?.byAgent ?? []).filter(
    (a) => a.attemptedAt !== null && now - a.attemptedAt <= interval * 3
      && (a.error !== null || !a.collectedAt || now - a.collectedAt > interval * 3),
  );
  // The proxy sees every call, the agent only what it recorded: the page counts the larger of the two.
  const proxy = data?.proxy;
  const proxyLines = (proxy?.available ? proxy.byAgent : []).filter((l) => l.metered || l.recorded > 0);
  const spent = proxy?.available ? Math.max(proxy.combinedCost, 0) : (t?.cost ?? 0);
  const extraAtProxy = proxy?.available ? Math.max(0, proxy.combinedCost - proxy.recordedCost) : 0;
  const maxDaily = Math.max(0, ...(data?.daily ?? []).map((d) => d.cost));
  // OpenClaw names an unpriced model `provider/model`, like the rows below.
  const unpricedModels = new Set((data?.unpriced ?? []).map((u) => u.model));

  const band = data?.pricing;
  const bandPill = band?.band ? (
    <Pill tone={band.band === 'off-peak' ? 'success' : 'neutral'}>
      {band.vendor} {band.band}{band.nextChange ? ` · until ${utcTime.format(new Date(band.nextChange))} UTC` : ''}
    </Pill>
  ) : undefined;

  return (
    <Page>
      <PageHeader eyebrow="Spend" title="Costs" description={COSTS_DESCRIPTION} action={bandPill} />

      <Tabs items={RANGES.map((r) => ({ label: r.label, active: range === r.id, onClick: () => setRange(r.id) }))} />

      {error && <Surface tone="danger"><span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span></Surface>}

      {data && !data.available && (
        <Surface tone="warning">
          <div className="ui-kicker">No figures yet</div>
          <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
            The Rev4a daemon reads every running agent each {Math.round(data.intervalS / 60)} min. If this stays empty, check that rev4a serve is running.
          </p>
        </Surface>
      )}

      {lagging.length > 0 && (
        <Surface tone="warning">
          <div className="ui-kicker">Not current</div>
          <div className="ui-key-values" style={{ marginTop: 8 }}>
            {lagging.map((a) => (
              <div className="ui-key-value" key={a.container}>
                <span>{a.name ?? a.container}</span>
                <span className="ui-muted">
                  {a.error ?? 'not read recently'}
                  {a.collectedAt ? ` · last read ${formatAge(now - a.collectedAt)}` : ' · never read'}
                </span>
              </div>
            ))}
          </div>
        </Surface>
      )}

      {data && data.unpriced.length > 0 && (
        <Surface tone="warning">
          <div className="ui-kicker">Calls without a price · last 30 days</div>
          <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
            OpenClaw counted these calls but could not price them, so they are not in the figures: the model is no longer in the catalogue, or has no price in model-pricing.json.
          </p>
          <div className="ui-key-values" style={{ marginTop: 8 }}>
            {data.unpriced.map((u) => (
              <div className="ui-key-value" key={u.model}>
                <span>{u.model}</span>
                <span>{u.calls} call{u.calls === 1 ? '' : 's'} · {u.agents.join(', ')}</span>
              </div>
            ))}
          </div>
        </Surface>
      )}

      {firstLoad ? <CostsCardsSkeleton /> : (
        <div className="costs-cards" style={{ opacity: stale ? 0.5 : 1 }}>
          <Surface as="article">
            <div className="ui-kicker">Spent</div>
            <div className="ui-metric-value">{formatCost(spent)}</div>
            {proxy?.available && (
              <div className="ui-muted" style={{ fontSize: 11, marginTop: 4 }}>
                The larger of what the proxy metered and what the agents recorded, per agent{extraAtProxy > 0.005 ? ` · ${formatCost(extraAtProxy)} more than the agents recorded` : ''}.
              </div>
            )}
            <div className="ui-key-values" style={{ marginTop: 12 }}>
              <div className="ui-key-value"><span className="ui-muted">Tokens</span><span>{formatTokens(t?.tokens ?? 0)}</span></div>
              <div className="ui-key-value">
                <span className="ui-muted">Days</span>
                <span>{data ? (data.startDate === data.endDate ? utcDay.format(new Date(data.endDate)) : `${utcDay.format(new Date(data.startDate))} – ${utcDay.format(new Date(data.endDate))}`) : '—'}</span>
              </div>
            </div>
          </Surface>

          <Surface as="article">
            <div className="ui-kicker">Where the money went</div>
            <div className="ui-key-values" style={{ marginTop: 12 }}>
              <div className="ui-key-value"><span className="ui-muted">Input</span><span>{formatCost(t?.inputCost ?? 0)}</span></div>
              <div className="ui-key-value"><span className="ui-muted">Output</span><span>{formatCost(t?.outputCost ?? 0)}</span></div>
              <div className="ui-key-value"><span className="ui-muted">Cache read</span><span>{formatCost(t?.cacheReadCost ?? 0)}</span></div>
              <div className="ui-key-value"><span className="ui-muted">Cache write</span><span>{formatCost(t?.cacheWriteCost ?? 0)}</span></div>
            </div>
          </Surface>

          <Surface as="article">
            <div className="ui-kicker">Tokens</div>
            <div className="ui-key-values" style={{ marginTop: 12 }}>
              <div className="ui-key-value"><span className="ui-muted">Input</span><span>{formatTokens(t?.input ?? 0)}</span></div>
              <div className="ui-key-value"><span className="ui-muted">Output</span><span>{formatTokens(t?.output ?? 0)}</span></div>
              <div className="ui-key-value"><span className="ui-muted">Cache read</span><span>{formatTokens(t?.cacheRead ?? 0)}</span></div>
              <div className="ui-key-value">
                <span className="ui-muted">Input served from cache</span>
                <span>{Math.round(share(t?.cacheRead ?? 0, (t?.input ?? 0) + (t?.cacheRead ?? 0) + (t?.cacheWrite ?? 0)))}%</span>
              </div>
            </div>
          </Surface>
        </div>
      )}

      {firstLoad ? <CostsBodySkeleton /> : data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: stale ? 0.5 : 1 }}>
          {data.range !== 'today' && (
            <Surface as="section">
              <div className="ui-kicker">Spent per day · UTC</div>
              <TimeSeriesChart
                label="Spent per day"
                points={data.daily.map((d) => ({ ts: dayStart(d.date), value: d.cost }))}
                from={dayStart(data.startDate)}
                to={dayStart(data.endDate)}
                bucket={DAY_S}
                yMax={maxDaily > 0 ? maxDaily * 1.2 : 1}
                formatValue={formatCost}
                formatTime={(ts) => utcDay.format(new Date(ts * 1000))}
              />
            </Surface>
          )}

          <div className="costs-lists">
            <Surface as="section">
              <div className="ui-kicker">By agent</div>
              {data.byAgent.length === 0 && <p className="ui-muted" style={{ fontSize: 12, marginTop: 12 }}>No agent has spent anything in this range.</p>}
              {data.byAgent.map((a) => (
                <BreakdownRow
                  key={a.container}
                  name={a.name ?? a.container}
                  figure={formatCost(a.cost)}
                  percent={share(a.cost, t?.cost ?? 0)}
                  label={`Share of the spend for ${a.name ?? a.container}`}
                  detail={`${a.container} · ${formatTokens(a.tokens)} tokens${a.missing ? ` · ${a.missing} unpriced` : ''}`}
                />
              ))}
            </Surface>

            <Surface as="section">
              <div className="ui-kicker">By model</div>
              {data.byModel.length === 0 && <p className="ui-muted" style={{ fontSize: 12, marginTop: 12 }}>No model calls in this range.</p>}
              {data.byModel.map((m) => (
                <BreakdownRow
                  key={`${m.provider}/${m.model}`}
                  name={m.model}
                  figure={formatCost(m.cost)}
                  percent={share(m.cost, t?.cost ?? 0)}
                  label={`Share of the spend for ${m.model}`}
                  detail={`${m.provider} · ${m.calls} call${m.calls === 1 ? '' : 's'} · ${formatTokens(m.tokens)} tokens${unpricedModels.has(`${m.provider}/${m.model}`) ? ' · no price, not counted' : ''}`}
                />
              ))}
            </Surface>
          </div>

          {proxyLines.length > 0 && (
            <Surface as="section">
              <div className="ui-kicker">Metered at the proxy · against what the agents recorded</div>
              <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
                Every call to a model through Rev4a is metered by the proxy, with the provider&apos;s own token counts and the price in force at that moment.
                An agent records only the calls that finished: a failed context compaction, or a call that looped and was cut, can be in the proxy&apos;s figure and not in the agent&apos;s.
                A gap is marked when the proxy saw more than 20% and more than {formatCost(0.1)} above the agent.
              </p>
              {proxyLines.map((l) => {
                const m = l.metered;
                const name = l.name ?? l.container ?? PROXY_CALLER_LABEL[m?.agent ?? ''] ?? m?.agent ?? l.key;
                return (
                  <div key={l.key} style={{ marginTop: 14 }}>
                    <div className="ui-key-value" style={{ fontSize: 12 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {name} {l.flagged && <Pill tone="warning">proxy saw +{formatCost(l.gap)}</Pill>}
                      </span>
                      <span>metered {m ? formatCost(m.cost) : '—'} · recorded {formatCost(l.recorded)}</span>
                    </div>
                    <Meter
                      percent={share(l.combined, proxy?.combinedCost ?? 0)}
                      level={l.flagged ? 'warning' : 'ok'}
                      label={`Share of the spend for ${name}`}
                    />
                    <div className="ui-muted" style={{ fontSize: 11, marginTop: 4 }}>
                      {m
                        ? [
                            `${m.calls} call${m.calls === 1 ? '' : 's'} at the proxy`,
                            m.errors ? `${m.errors} failed` : null,
                            m.noUsage ? `${m.noUsage} without a usage report` : null,
                            `${formatTokens(m.promptTokens + m.completionTokens)} tokens`,
                            m.cachedTokens ? `${formatTokens(m.cachedTokens)} from cache` : null,
                            l.recordedTokens ? `agent recorded ${formatTokens(l.recordedTokens)} tokens` : 'agent recorded nothing',
                          ].filter(Boolean).join(' · ')
                        : 'nothing went through the proxy (the agent may use another provider)'}
                    </div>
                  </div>
                );
              })}
            </Surface>
          )}

          {data.reconciliation.length > 0 && (
            <Surface as="section">
              <div className="ui-kicker">Against the bill</div>
              <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
                What each vendor charged (its balance or usage, read every hour) next to what the agents priced, over the same readings.
                The same key also pays for the assistant and any client outside Rev4a, and DeepSeek gives its balance to the cent: a small gap is normal.
              </p>
              <div className="ui-key-values" style={{ marginTop: 8 }}>
                {data.reconciliation.map((r) => {
                  const name = VENDOR_LABEL[r.vendor] ?? r.vendor;
                  if (r.billed === null || r.priced === null || !r.from || !r.to) {
                    return (
                      <div className="ui-key-value" key={r.vendor}>
                        <span>{name}</span>
                        <span className="ui-muted">{r.readings ? 'one reading so far — the comparison starts with the next, within the hour' : 'no reading in this range'}</span>
                      </div>
                    );
                  }
                  if (!r.comparable) {
                    return (
                      <div className="ui-key-value" key={r.vendor}>
                        <span>{name}</span>
                        <span className="ui-muted">billed in {r.currency}, not comparable with dollars</span>
                      </div>
                    );
                  }
                  const gap = r.billed - r.priced;
                  return (
                    <div key={r.vendor} style={{ marginTop: 6 }}>
                      <div className="ui-key-value" style={{ fontSize: 12 }}>
                        <span>{name}</span>
                        <span>billed {formatCost(r.billed)} · priced {formatCost(r.priced)} · gap {gap < 0 ? '−' : '+'}{formatCost(Math.abs(gap))}</span>
                      </div>
                      <div className="ui-muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {sessionTime.format(new Date(r.from))} → {sessionTime.format(new Date(r.to))} · {r.readings} readings
                        {r.topUps > 0 ? ` · ${formatCost(r.topUps)} added to the balance (not counted as spend)` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Surface>
          )}

          <Surface as="section">
            <div className="ui-kicker">Most expensive sessions</div>
            {data.sessions.length === 0 && <p className="ui-muted" style={{ fontSize: 12, marginTop: 12 }}>No session was active in this range.</p>}
            {data.sessions.map((s) => (
              <BreakdownRow
                key={`${s.container}/${s.sessionId}`}
                name={s.label || s.sessionKey || s.sessionId}
                figure={formatCost(s.cost)}
                percent={share(s.cost, data.sessions[0]?.cost ?? 0)}
                label={`Cost of ${s.label || s.sessionId} relative to the most expensive session`}
                detail={[
                  s.agentName ?? s.container,
                  s.model,
                  `${formatTokens(s.tokens)} tokens`,
                  s.missing ? `${s.missing} unpriced` : null,
                  s.lastActivity ? `last active ${sessionTime.format(new Date(s.lastActivity))}` : null,
                ].filter(Boolean).join(' · ')}
              />
            ))}
            {data.sessions.length > 0 && (
              <p className="ui-muted" style={{ fontSize: 11, marginTop: 14 }}>
                A session&apos;s figure is its total over the last 30 days, not only this range.
              </p>
            )}
          </Surface>
        </div>
      )}
    </Page>
  );
}
