'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { SkeletonLines } from '../components/Skeleton';
import { Button, AgentCard, AgentStartDialog, Badge, ConfirmModal, Input, Pill, Surface, type AgentStartPrompt, type Tone } from '../components/ui';
import PasswordInput from '../components/PasswordInput';
import ImageDownloadBanner from './ImageDownloadBanner';
import ChannelManager from './ChannelManager';
import ModelSection from './ModelSection';
import ModelSetupModal from './ModelSetupModal';
import CostSection from './CostSection';
import { AgentSpendAlerts } from '../system/AgentSpendAlerts';
import ResourceSection from './ResourceSection';
import PackagesSection from './PackagesSection';
import CredentialsSection from './CredentialsSection';
import PortsSection from './PortsSection';
import BrowserAccessSection, { Elapsed, OpenControlUiButton, type GatewayState } from './BrowserAccessSection';
import UpdateSection from './UpdateSection';
import { validatePortInput, type PortBindings } from '@/lib/agent-ports';
import { agentPortsLabel, requestAgentLifecycle } from '@/lib/agent-start';
import { needsModelSetup } from '@/lib/agent-model-setup';
import { GATEWAY_POLL_STUCK_MS, skipGatewayTick } from '@/lib/gateway-state';
import {
  InfoIcon, BracesIcon, KeyIcon, TrashIcon, TerminalIcon,
  LinkIcon, ArchiveIcon, RotateIcon, PackageIcon,
} from '../components/Icons';

/**
 * The model as the agent card shows it. A subscription model reads "<id> · ChatGPT" for a bare
 * `openai/<id>` and "<id> · Claude" for a bare `anthropic/<id>`: some ids also exist as paid
 * proxy models (`rev4a/openai/gpt-5.6-sol`, `rev4a/anthropic/...`), and the two would otherwise
 * look identical. A proxy model loses its `rev4a/` prefix, as before.
 */
function modelLabel(ref: string): string {
  if (ref.startsWith('openai/')) return `${ref.slice('openai/'.length)} · ChatGPT`;
  if (ref.startsWith('anthropic/')) return `${ref.slice('anthropic/'.length)} · Claude`;
  return ref.replace(/^rev4a\//, '');
}

/** Section header with an identifying icon. `danger` switches to the red palette. */
function SectionHeader({ icon, label, danger = false }: { icon: React.ReactNode; label: string; danger?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '8px 14px',
      borderBottom: `1px solid ${danger ? 'rgba(239,68,68,0.15)' : 'var(--border)'}`,
      color: danger ? '#ef4444' : 'var(--violet)',
      fontSize: 10, letterSpacing: '0.08em',
    }}>
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
      {label}
    </div>
  );
}

interface Agent {
  id: string;
  agentId: string;
  name: string;
  displayName?: string;
  image: string;
  imageTag: string;
  template: string | null;
  status: string;
  state: string;
  ports: string;
  ip: string | null;
  created: string | null;
  env: string[];
  controlPort: string | null;
  /** Host address the Control UI port is published on; null/0.0.0.0 = every interface. Never a token. */
  controlUiHostIp?: string | null;
  publicUrl?: string | null;
  domainConfigured?: boolean;
  portBindings?: PortBindings;
  portsDiffer?: boolean;
  /** OpenClaw version the agent runs; null when it cannot be read (stopped agent on an unlabelled image). */
  openclawVersion?: string | null;
  /** A newer supported OpenClaw version is downloaded. */
  updateAvailable?: boolean;
  /** The build this release pins for the agent's version is downloaded and the agent runs another image. */
  newBuildAvailable?: boolean;
}

/**
 * The floating Wizard and Pulse buttons are `position: fixed` over the bottom of the content
 * (44 px high, up to ~44 px above its end): the scroll regions end with this much padding so the
 * last content scrolls clear of them.
 */
const FLOATING_CLEARANCE = 64;

type FilterState = 'all' | 'running' | 'exited';

const STATUS_BULLET: Record<string, string> = {
  running: '#22c55e',
  exited: '#ef4444',
  paused: '#f59e0b',
  restarting: '#3b82f6',
};

function fmtCreated(created: string | null): string {
  if (!created) return '-';
  const ms = Date.now() - new Date(created).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function NoProviderBanner() {
  return (
    <Surface as="aside" compact>
      No API keys yet — agents can use your ChatGPT or Claude subscription, or add a key in the{' '}
      <a href="/gateway" className="ui-link">Gateway</a>.
    </Surface>
  );
}

function ConnectSubscriptionButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="primary" size="sm" onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}>
      Connect subscription
    </Button>
  );
}

function clearSetupParam() {
  const url = new URL(window.location.href);
  url.searchParams.delete('setup');
  window.history.replaceState(null, '', url);
}

/**
 * The image as the card shows it. An agent whose image lost its tag reports a bare digest
 * (`sha256:<64 hex>`): show the OpenClaw version when known, else the first 12 hex digits.
 */
function imageLabel(agent: Agent): string {
  const image = agent.image || '';
  if (/^sha256:/i.test(image)) {
    if (agent.openclawVersion) return `OpenClaw ${agent.openclawVersion}`;
    return `sha256:${image.slice('sha256:'.length, 'sha256:'.length + 12)}`;
  }
  return image.includes('/') ? image.split('/').pop() ?? image : image;
}

/**
 * Publish mappings as the card shows them: consecutive host and container ports (same protocol)
 * become one range, `3710–3715 → 3000–3005`; mappings that do not continue a run stay listed.
 */
function compactPorts(ports: string): string {
  const parsed = (ports || '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^(\d+):(\d+)(\/\w+)?$/.exec(p);
    return m ? { raw: p, host: +m[1], cont: +m[2], proto: m[3] ?? '' } : { raw: p, host: NaN, cont: NaN, proto: '' };
  });
  // Numeric order by host port; the sort is stable, and unparseable entries keep their order, after the others.
  parsed.sort((x, y) => {
    if (Number.isNaN(x.host) || Number.isNaN(y.host)) return Number.isNaN(x.host) === Number.isNaN(y.host) ? 0 : Number.isNaN(x.host) ? 1 : -1;
    return x.host - y.host || x.cont - y.cont;
  });
  const out: string[] = [];
  let i = 0;
  while (i < parsed.length) {
    const a = parsed[i];
    if (Number.isNaN(a.host)) { out.push(a.raw); i++; continue; }
    let j = i;
    while (j + 1 < parsed.length && parsed[j + 1].host === parsed[j].host + 1 && parsed[j + 1].cont === parsed[j].cont + 1 && parsed[j + 1].proto === a.proto) j++;
    const b = parsed[j];
    out.push(j === i ? `${a.host} → ${a.cont}${a.proto}` : `${a.host}–${b.host} → ${a.cont}–${b.cont}${a.proto}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** One agent's Gateway state from `/api/agents/gateway`. */
type GatewayInfo = { state: GatewayState; startedAtMs: number | null; blocksOpen?: boolean };

/** Shared agent list-item used in both mobile and desktop views. */
function AgentListItem({
  agent,
  loading,
  selected,
  channelSummary,
  modelSummary,
  deviceSummary,
  backupSummary,
  gatewaySummary,
  busy,
  onClick,
  onLifecycle,
  onSetupModel,
}: {
  agent: Agent;
  loading: boolean;
  selected?: boolean;
  channelSummary: Record<string, { telegram: boolean }>;
  modelSummary: Record<string, { primary: string | null; health: string; fallbackCount: number; firstFallback?: string | null }>;
  /** Browsers waiting for approval, per agent. */
  deviceSummary: Record<string, { pending: number }>;
  /** Gateway readiness, per agent (STARTING / NOT READY chip, Open button). */
  gatewaySummary: Record<string, GatewayInfo>;
  /** Cold backup currently running, per agent (chip on the card). */
  /** The long operation in progress, per agent (chip on the card). */
  backupSummary: Record<string, { kind: 'backup' | 'restore' | 'recreate' | 'update' | 'edit'; file?: string | null; version?: string | null; percent?: number | null }>;
  /** Any long operation running on this agent: the lifecycle toggle is disabled. */
  busy?: boolean;
  onClick: () => void;
  onLifecycle: () => void;
  onSetupModel: () => void;
}) {
  const row = modelSummary[agent.agentId];
  const modelMissing = needsModelSetup(row);
  let model: React.ReactNode = null;
  if (modelMissing) {
    model = <Pill tone="warning" title="Connect a subscription or add an API key">No model</Pill>;
  } else if (row && row.primary) {
    // A bare `openai/<id>` or `anthropic/<id>` is a subscription model: it is not in the Rev4a
    // catalogue on purpose, so the catalogue health the summary computes does not apply to it.
    // Whether the agent is signed in is shown in its panel (Subscription line), so the card
    // shows a neutral state, neither green nor red.
    const primary: string = row.primary;
    const isSubscription = primary.startsWith('openai/') || primary.startsWith('anthropic/');
    const m = { ...row, primary, health: isSubscription ? 'subscription' : row.health };
    // Tone follows what the operator has to do about it: red means the agent
    // will fail on its next turn, amber means it still works on a retired name.
    // The red states differ in remedy — pick another model for the first two,
    // run Sync All on the Gateway page for OUT OF SYNC.
    const failing = m.health === 'missing' || m.health === 'disabled' || m.health === 'out-of-sync';
    const tone = failing ? 'danger' : m.health === 'deprecated' ? 'warning' : undefined;
    const chip = m.health === 'missing' ? 'NOT IN CATALOGUE'
               : m.health === 'disabled' ? 'NOT ENABLED'
               : m.health === 'out-of-sync' ? 'OUT OF SYNC'
               : m.health === 'deprecated' ? 'DEPRECATED'
               // Mirrors subscriptionChip() in lib/subscriptions-parse.js (tested there; that module
               // evaluates code at load and stays out of the browser bundle): a subscription primary
               // with no fallback goes silent at the usage limit, so it keeps the warning.
               : m.health === 'subscription' ? (m.fallbackCount === 0 ? 'NO FALLBACK' : null)
               : m.fallbackCount === 0 ? 'NO FALLBACK' : null;
    model = (
      <>
        <span style={{ overflowWrap: 'anywhere' }}>
          {modelLabel(m.primary)}
          {/* Only the first fallback: a list here would drown the row, and the
              full set is editable in the detail panel anyway. */}
          {m.firstFallback && (
            <span style={{ opacity: 0.75 }}>
              {' ↳ '}{modelLabel(m.firstFallback)}
              {m.fallbackCount > 1 && ` +${m.fallbackCount - 1}`}
            </span>
          )}
        </span>
        {chip && (
          <Badge tone={(tone ?? 'neutral') as Tone}>
            <span style={{ fontSize: 8, padding: '1px 6px' }}>{chip}</span>
          </Badge>
        )}
      </>
    );
  }

  const pending = deviceSummary[agent.agentId]?.pending ?? 0;
  const b = backupSummary[agent.agentId];
  const activity = !b ? null
    : b.kind === 'backup' ? (b.percent !== null && b.percent !== undefined ? `BACKUP ${b.percent}%` : 'BACKUP…')
    : b.kind === 'restore' ? 'RESTORING'
    : b.kind === 'recreate' ? 'RECREATING'
    : b.kind === 'edit' ? 'EDITING'
    : 'UPDATING';
  const gw = agent.state === 'running' ? gatewaySummary[agent.agentId] : undefined;
  const hasChips = agent.portsDiffer || !!b || gw?.state === 'starting' || gw?.state === 'not_ready' || channelSummary[agent.agentId]?.telegram || pending > 0 || agent.updateAvailable || agent.newBuildAvailable;
  const chips = hasChips ? (
    <>
      {agent.portsDiffer && <Pill tone="warning" title="Recreate to apply the Remote access setting">Ports: {agentPortsLabel(agent.controlUiHostIp)}</Pill>}
      {activity && <Badge tone="neutral"><span style={{ fontSize: 8, padding: '1px 6px' }}>{activity}</span></Badge>}
      {gw?.state === 'starting' && (
        <Badge tone="neutral"><span style={{ fontSize: 8, padding: '1px 6px' }}>STARTING <Elapsed startedAtMs={gw.startedAtMs} /></span></Badge>
      )}
      {gw?.state === 'not_ready' && (
        <Badge tone="danger"><span style={{ fontSize: 8, padding: '1px 6px' }}>NOT READY</span></Badge>
      )}
      {channelSummary[agent.agentId]?.telegram && (
        <Badge tone="success"><span style={{ fontSize: 8, padding: '1px 6px' }}>TG</span></Badge>
      )}
      {pending > 0 && (
        <Badge tone="warning">
          <span style={{ fontSize: 8, padding: '1px 6px' }}>{pending === 1 ? 'BROWSER WAITING' : `${pending} BROWSERS WAITING`}</span>
        </Badge>
      )}
      {(agent.updateAvailable || agent.newBuildAvailable) && (
        <Badge tone="warning"><span style={{ fontSize: 8, padding: '1px 6px' }}>{agent.updateAvailable ? 'UPDATE AVAILABLE' : 'NEW BUILD'}</span></Badge>
      )}
    </>
  ) : null;

  return (
    <AgentCard
      name={agent.displayName || agent.name}
      template={agent.template}
      running={agent.state === 'running'}
      toggling={loading}
      toggleDisabled={agent.state === 'unknown' || !!busy}
      onToggle={() => { void onLifecycle(); }}
      action={modelMissing ? <ConnectSubscriptionButton onClick={onSetupModel} />
        : agent.state === 'running' && agent.controlPort ? <OpenControlUiButton agentId={agent.agentId} hostIp={agent.controlUiHostIp} publicUrl={agent.domainConfigured === false ? undefined : agent.publicUrl} stopPropagation gateway={gw?.state} blocksOpen={gw?.blocksOpen} /> : undefined}
      meta={[
        imageLabel(agent),
        compactPorts(agent.ports),
      ]}
      model={model}
      chips={chips}
      selected={selected}
      onSelect={onClick}
    />
  );
}

export default function AgentsPageClient() {
  const router = useRouter();
  // "+ New" navigates with router.push, which prefetches nothing: warm the route up front,
  // so the click shows Create Agent (or its loading frame) at once.
  useEffect(() => { router.prefetch('/agents/create'); }, [router]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<FilterState>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [setupAgentId, setSetupAgentId] = useState<string | null>(null);
  const [scrollModelFor, setScrollModelFor] = useState<string | null>(null);
  const [modelRevisions, setModelRevisions] = useState<Record<string, number>>({});
  const [isMobile, setIsMobile] = useState(false);
  const [showList, setShowList] = useState(true);
  const [chSummary, setChSummary] = useState<Record<string, { telegram: boolean }>>({});
  const [mdSummary, setMdSummary] = useState<Record<string, { primary: string | null; health: string; fallbackCount: number; firstFallback?: string | null }>>({});
  const [dvSummary, setDvSummary] = useState<Record<string, { pending: number }>>({});
  const [bkSummary, setBkSummary] = useState<Record<string, { kind: 'backup' | 'restore' | 'recreate' | 'update' | 'edit'; file?: string | null; version?: string | null; percent?: number | null }>>({});
  const [gwSummary, setGwSummary] = useState<Record<string, GatewayInfo>>({});
  /** Poll the Gateway state every 3 s until this time (an agent was just started here). */
  const [gwBoostUntil, setGwBoostUntil] = useState(0);
  const gwAbortRef = useRef<AbortController | null>(null);
  /** Consecutive failed Gateway fetches: three clear the stored states, so a stale lock cannot linger. */
  const gwFailures = useRef(0);
  /** When the Gateway request in flight started (null: none): interval ticks skip instead of aborting it. */
  const gwInFlight = useRef<number | null>(null);
  const [imageReady, setImageReady] = useState(true);
  // Unknown status keeps the banner hidden while the agent list loads independently.
  const [providersConfigured, setProvidersConfigured] = useState<boolean | null>(null);
  const [gatewayToken, setGatewayToken] = useState('');
  const [tokenLoading, setTokenLoading] = useState(true);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenStatus, setTokenStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState<string | null>(null);
  const lifecycleBusyRef = useRef(false);
  const lifecycleAbortRef = useRef<AbortController | null>(null);
  const listAbortRef = useRef<AbortController | null>(null);
  const listLoads = useRef(0);
  const mdSummaryAbortRef = useRef<AbortController | null>(null);
  const [startPrompt, setStartPrompt] = useState<AgentStartPrompt | null>(null);
  const [lifecycleError, setLifecycleError] = useState('');
  useEffect(() => () => {
    lifecycleAbortRef.current?.abort();
    listAbortRef.current?.abort();
    mdSummaryAbortRef.current?.abort();
  }, []);
  const skipNextPoll = useRef(false);
  /** Guards the un-awaited channel-summary fetch against out-of-order responses. */
  const chSummarySeq = useRef(0);
  const dvSummarySeq = useRef(0);
  const bkSummarySeq = useRef(0);

  /**
   * Refresh the per-agent model rows that feed the card chips.
   *
   * Shared by the 15s poll and by a save in the detail panel: without the second
   * caller the chip kept showing the previous model until the next poll, which
   * reads as "the save did not work".
   *
   * A save can overlap the poll. Cancel the earlier read so it cannot restore stale chips.
   */
  const refreshModelSummary = useCallback(async () => {
    mdSummaryAbortRef.current?.abort();
    const controller = new AbortController();
    mdSummaryAbortRef.current = controller;
    try {
      const res = await fetch('/api/agents/models-summary', { signal: controller.signal });
      if (!res.ok) return;
      const payload = await res.json();
      if (controller.signal.aborted) return;
      const byId: Record<string, { primary: string | null; health: string; fallbackCount: number; firstFallback?: string | null }> = {};
      for (const row of payload.agents ?? []) byId[row.agentId] = row;
      setMdSummary(byId);
    } catch { /* badges are optional */ }
  }, []);

  /**
   * Refresh the "browser waiting" badges. Shared by the poll and by an approve,
   * reject or revoke in the detail panel, and sequence-guarded against stale reads.
   */
  const refreshDeviceSummary = useCallback(async () => {
    const seq = ++dvSummarySeq.current;
    try {
      const res = await fetch('/api/agents/devices-summary');
      if (!res.ok || seq !== dvSummarySeq.current) return;
      const payload = await res.json();
      // A row whose read failed carries `error: true` and no count: keep the previous
      // value instead of writing zero, which would hide a request that is really waiting.
      setDvSummary((prev) => {
        const next: Record<string, { pending: number }> = {};
        for (const row of payload.agents ?? []) {
          if (row.error === true) {
            if (prev[row.agentId]) next[row.agentId] = prev[row.agentId];
            continue;
          }
          next[row.agentId] = { pending: row.pending ?? 0 };
        }
        return next;
      });
    } catch { /* badges are optional */ }
  }, []);

  /**
   * Refresh the activity chips (`BACKUP nn%`, `RESTORING`, `RECREATING`, `EDITING`, `UPDATING`)
   * from `/api/agents/activity-summary`. Sequence-guarded like the other summaries.
   */
  const refreshBackupSummary = useCallback(async () => {
    const seq = ++bkSummarySeq.current;
    try {
      const res = await fetch('/api/agents/activity-summary');
      if (!res.ok || seq !== bkSummarySeq.current) return;
      const payload = await res.json();
      const byId: Record<string, { kind: 'backup' | 'restore' | 'recreate' | 'update' | 'edit'; file?: string | null; version?: string | null; percent?: number | null }> = {};
      for (const row of payload.agents ?? []) byId[row.agentId] = row;
      setBkSummary(byId);
    } catch { /* badges are optional */ }
  }, []);

  /**
   * A long job just started from the detail panel. Shows its chip at once instead of
   * waiting for the next list poll, then lets `refreshBackupSummary()` confirm it.
   */
  const notifyActivity = useCallback((agentId: string, kind: 'backup' | 'restore' | 'recreate' | 'update' | 'edit') => {
    setBkSummary((prev) => ({ ...prev, [agentId]: { kind } }));
    setGwBoostUntil(Date.now() + 20000);
    void refreshBackupSummary();
  }, [refreshBackupSummary]);

  // While any backup runs the chips follow the live percent at 2s; when none
  // runs the dedicated timer stops and the summary only rides the 15s poll.
  const anyBackupRunning = Object.keys(bkSummary).length > 0;
  useEffect(() => {
    if (!anyBackupRunning) return;
    const i = setInterval(() => { void refreshBackupSummary(); }, 2000);
    return () => clearInterval(i);
  }, [anyBackupRunning, refreshBackupSummary]);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  /**
   * Gateway readiness per agent. Decorates the cards and the Open buttons, so a failure
   * leaves the last answer in place and never blocks anything. An explicit call aborts the
   * one still in flight; an interval tick (`fromTimer`) skips instead, so a slow probe is
   * never aborted every tick and its answer can arrive. A request older than 20 s counts as stuck:
   * it is aborted and counted as a failure, so three of them clear the states and Open is enabled.
   */
  const refreshGateway = useCallback(async (fromTimer = false) => {
    if (fromTimer && skipGatewayTick(gwInFlight.current, Date.now())) return;
    const since = gwInFlight.current;
    if (since !== null && Date.now() - since >= GATEWAY_POLL_STUCK_MS
      && ++gwFailures.current >= 3) setGwSummary((prev) => (Object.keys(prev).length ? {} : prev));
    gwAbortRef.current?.abort();
    const controller = new AbortController();
    gwAbortRef.current = controller;
    gwInFlight.current = Date.now();
    try {
      const res = await fetch('/api/agents/gateway', { signal: controller.signal });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      if (!data || typeof data.agents !== 'object' || !data.agents) throw new Error('Invalid response');
      gwFailures.current = 0;
      setGwSummary(data.agents);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      if (++gwFailures.current >= 3) setGwSummary((prev) => (Object.keys(prev).length ? {} : prev));
    } finally {
      // Only the newest request owns the flag: an aborted older one must not clear it.
      if (gwAbortRef.current === controller) gwInFlight.current = null;
    }
  }, []);

  /** An agent was just (re)started from this page: poll fast for a while and look at once. */
  const boostGateway = useCallback(() => {
    setGwBoostUntil(Date.now() + 20000);
    void refreshGateway();
  }, [refreshGateway, refreshModelSummary, refreshDeviceSummary, refreshBackupSummary]);

  const anyGatewayStarting = Object.values(gwSummary).some((g) => g.state === 'starting');
  const gwFast = anyGatewayStarting || gwBoostUntil > 0;
  useEffect(() => {
    void refreshGateway();
    const i = setInterval(() => { void refreshGateway(true); }, gwFast ? 3000 : 30000);
    return () => clearInterval(i);
  }, [gwFast, refreshGateway]);
  useEffect(() => () => gwAbortRef.current?.abort(), []);
  useEffect(() => {
    if (gwBoostUntil === 0) return;
    const t = setTimeout(() => setGwBoostUntil(0), Math.max(0, gwBoostUntil - Date.now()));
    return () => clearTimeout(t);
  }, [gwBoostUntil]);

  const load = useCallback(async () => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    try {
      const res = await fetch('/api/agents', { signal: controller.signal });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (!Array.isArray(data)) throw new Error('Invalid response');
      listLoads.current += 1;
      setAgents(data);
      setError('');

      // Channel summary is deliberately not awaited: it only decorates rows with
      // a TG badge, and awaiting it here held the whole page behind a second
      // round trip — the agent list was ready in ~0.25s but stayed hidden for
      // ~1.15s. It now lands on its own and the badges appear when it does.
      //
      // Sequence-guarded: load() also runs on a 15s poll, so several of these can
      // be in flight at once. Without the check, a slow earlier response landing
      // after a faster later one would overwrite fresh badges with stale ones.
      const seq = ++chSummarySeq.current;
      void (async () => {
        try {
          const chRes = await fetch('/api/agents/channels-summary');
          if (!chRes.ok || seq !== chSummarySeq.current) return;
          setChSummary(await chRes.json());
        } catch { /* badges are optional */ }
      })();

      // Same treatment for the model summary: it decorates rows, so it must not
      // hold the list, and a slow earlier response must not overwrite a newer one.
      void refreshModelSummary();
      void refreshDeviceSummary();
      void refreshBackupSummary();
      // Like a tick: the 15 s list poll must not abort a slow Gateway request that is still young.
      void refreshGateway(true);
    } catch (e: any) {
      if (controller.signal.aborted || e?.name === 'AbortError') return;
      setError(e.message || 'Loading error');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [refreshGateway, refreshModelSummary]);

  useEffect(() => {
    load();
    const i = setInterval(() => {
      if (skipNextPoll.current) { skipNextPoll.current = false; return; }
      load();
    }, 15000);
    return () => clearInterval(i);
  }, [load]);

  // Check if agent base image exists (needed for creating agents)
  useEffect(() => {
    fetch('/api/agents/image-status')
      .then((r) => r.json())
      .then((d: { exists: boolean }) => setImageReady(d.exists))
      .catch(() => setImageReady(false));
  }, []);

  // Check if any upstream provider is configured in the Gateway.
  useEffect(() => {
    const controller = new AbortController();
    // summary=1: skips the live-pricing round trip we don't need here.
    fetch('/api/gateway/provider?summary=1', { signal: controller.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { providers?: Array<{ provider: string; configured: boolean }> } | null) => {
        if (!controller.signal.aborted && Array.isArray(d?.providers)) {
          setProvidersConfigured(d.providers.some((p) => p.configured && p.provider !== 'rev4a'));
        }
      })
      .catch(() => { /* the banner is optional */ });
    return () => controller.abort();
  }, []);

  // Load gateway token
  const loadToken = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/token');
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json();
      setGatewayToken(typeof data.token === 'string' ? data.token : '');
    } catch {
      // token not available
    } finally {
      setTokenLoading(false);
    }
  }, []);

  useEffect(() => { loadToken(); }, [loadToken]);

  // Auto-clear token status after 4 seconds
  // A warning (agents left on the old token) stays until the next save.
  useEffect(() => {
    if (!tokenStatus || tokenStatus.type !== 'success') return;
    const t = setTimeout(() => setTokenStatus(null), 4000);
    return () => clearTimeout(t);
  }, [tokenStatus]);

  const handleImageReady = useCallback(() => {
    setImageReady(true);
  }, []);

  const handleLifecycle = useCallback(async (agent: Agent) => {
    if (lifecycleBusyRef.current || startPrompt) return;
    lifecycleBusyRef.current = true;
    const action = agent.state === 'running' ? 'stop' : 'start';
    setLifecycleLoading(agent.agentId);
    setLifecycleError('');
    lifecycleAbortRef.current?.abort();
    const controller = new AbortController();
    lifecycleAbortRef.current = controller;
    try {
      const result = await requestAgentLifecycle(agent.agentId, action, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === 'ports_differ') {
        setStartPrompt({ agentId: agent.agentId, name: agent.displayName || agent.name, hostIp: agent.controlUiHostIp, setting: result.setting });
        return;
      }
      // Refresh agent list to pick up new state; skip the next polling cycle
      skipNextPoll.current = true;
      if (action === 'start') boostGateway();
      void load();
    } catch (e: unknown) {
      if (!controller.signal.aborted && (e as Error).name !== 'AbortError') setLifecycleError((e as Error).message);
    } finally {
      lifecycleBusyRef.current = false;
      setLifecycleLoading(null);
    }
  }, [load, boostGateway, startPrompt]);

  const lifecycleFeedback = <>
    {lifecycleError && <p role="alert">{lifecycleError}</p>}
    {startPrompt && <AgentStartDialog key={startPrompt.agentId} prompt={startPrompt}
      onClose={() => setStartPrompt(null)} onStarted={() => { boostGateway(); void refreshBackupSummary(); }}
      onComplete={() => { setStartPrompt(null); boostGateway(); void load(); }} />}
  </>;

  async function saveToken() {
    setTokenSaving(true);
    setTokenStatus(null);
    try {
      const res = await fetch('/api/agents/token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: gatewayToken }),
      });
      const data = await res.json();
      // No per-agent outcome (Docker unreachable, bad payload): show the error alone.
      if (typeof data.containersUpdated !== 'number') throw new Error(data.error || 'Save failed');
      const parts = [`${data.containersUpdated} running agent(s) restarted`];
      if (data.stoppedUpdated) parts.push(`${data.stoppedUpdated} stopped agent(s) updated, applied at their next start`);
      if (data.skipped?.length) parts.push(`not updated (busy or paused, save again later): ${data.skipped.join(', ')}`);
      if (data.failed?.length) parts.push(`failed: ${data.failed.map((f: { container: string }) => f.container).join(', ')}`);
      const clean = data.success && !data.skipped?.length;
      setTokenStatus({ type: clean ? 'success' : 'error', message: `Saved: ${parts.join('; ')}.${clean ? '' : ' Agents not updated still accept the old token.'}` });
    } catch (e: any) {
      setTokenStatus({ type: 'error', message: e.message || 'Save failed' });
    } finally {
      setTokenSaving(false);
    }
  }

  const filtered = useMemo(() => {
    let list = [...agents];
    if (filter === 'running') list = list.filter((a) => a.state === 'running');
    if (filter === 'exited') list = list.filter((a) => a.state === 'exited');
    return list;
  }, [agents, filter]);

  // Derive the selected agent from the live list rather than holding a snapshot.
  // A snapshot goes stale on every 15s poll (status, ports, version) and
  // survives deletion; deriving means a rename shows up on the next load() and a
  // deleted agent can't leave a detail panel pointing at something that's gone.
  const selected = useMemo(
    () => (selectedId ? agents.find((a) => a.agentId === selectedId) ?? null : null),
    [agents, selectedId],
  );

  // The selection can vanish under us — deleted here, or from another tab/CLI
  // and picked up by the poll. Drop it so mobile falls back to the list instead
  // of rendering a dead detail view.
  useEffect(() => {
    if (selectedId && !agents.some((a) => a.agentId === selectedId)) {
      setSelectedId(null);
      setShowList(true);
    }
  }, [agents, selectedId]);

  // Deep link `/agents?agent=<id>` (the Subscriptions page uses it): select that agent once the
  // list has loaded, one time only, so the operator's own later choice is never overridden.
  const deepLinked = useRef(false);
  const setupDeepLink = useRef<string | null>(null);
  // Opened by the operator: a `?setup=1` link still waiting for its agent must not replace this dialog later.
  const openSetup = useCallback((agentId: string) => {
    if (setupDeepLink.current) {
      setupDeepLink.current = null;
      clearSetupParam();
    }
    setSetupAgentId(agentId);
  }, []);
  useEffect(() => {
    if (deepLinked.current) return;
    const url = new URL(window.location.href);
    const wanted = url.searchParams.get('agent');
    const hit = wanted ? agents.find((a) => a.agentId === wanted) : null;
    if (url.searchParams.get('setup') === '1') {
      setupDeepLink.current = wanted;
      if (!hit) {
        if (wanted && listLoads.current < 3) return;
        setupDeepLink.current = null;
        clearSetupParam();
      }
    } else if (agents.length === 0) {
      return;
    }
    deepLinked.current = true;
    if (hit) {
      setSelectedId(hit.agentId);
      if (isMobile) setShowList(false);
      if (url.hash === '#model-section') setScrollModelFor(hit.agentId);
    }
  }, [agents, isMobile]);

  useEffect(() => {
    const agentId = setupDeepLink.current;
    if (!agentId || selectedId !== agentId || !agents.some((agent) => agent.agentId === agentId)) return;
    const row = mdSummary[agentId];
    if (!row?.health || row.health === 'unknown') return;
    setupDeepLink.current = null;
    if (needsModelSetup(row)) setSetupAgentId(agentId);
    clearSetupParam();
  }, [agents, mdSummary, selectedId]);

  useEffect(() => {
    if (!scrollModelFor || scrollModelFor !== selectedId || loading || error || (isMobile && showList)) return;
    const section = document.getElementById('model-section');
    if (section) {
      section.scrollIntoView({ block: 'start' });
      setScrollModelFor(null);
    }
  }, [scrollModelFor, selectedId, loading, error, isMobile, showList]);

  /** An agent was deleted: drop it optimistically, then reconcile with the server. */
  const handleAgentDeleted = useCallback((agentId: string) => {
    // The DELETE already succeeded server-side, so removing it here is safe and
    // spares the user the round trip — the API tears down container, volume and
    // backups before it answers, which takes seconds.
    setAgents((prev) => prev.filter((a) => a.agentId !== agentId));
    void load();
  }, [load]);

  function cancelSetupDeepLink() {
    if (!setupDeepLink.current) return;
    clearSetupParam();
    setupDeepLink.current = null;
    deepLinked.current = true;
  }

  function selectAgent(agent: Agent) {
    cancelSetupDeepLink();
    setScrollModelFor(null);
    setSelectedId(agent.agentId);
    if (isMobile) setShowList(false);
  }

  function backToList() {
    cancelSetupDeepLink();
    setScrollModelFor(null);
    setShowList(true);
  }

  const setupAgent = agents.find((agent) => agent.agentId === setupAgentId);
  function modelSaved(agentId: string) {
    // The save confirms a primary exists. Catalogue health will come from the next read.
    setMdSummary((previous) => {
      const row = previous[agentId];
      return needsModelSetup(row) ? { ...previous, [agentId]: { ...row, health: 'unknown' } } : previous;
    });
    void refreshModelSummary();
  }

  function finishModelSetup(agentId: string) {
    setSetupAgentId(null);
    setModelRevisions((previous) => ({ ...previous, [agentId]: (previous[agentId] ?? 0) + 1 }));
  }

  const setupModal = setupAgent && (
    <ModelSetupModal
      key={setupAgent.agentId}
      agentId={setupAgent.agentId}
      agentName={setupAgent.displayName || setupAgent.name}
      onClose={() => setSetupAgentId(null)}
      onDone={() => {
        finishModelSetup(setupAgent.agentId);
        modelSaved(setupAgent.agentId);
      }}
      onChoose={() => {
        selectAgent(setupAgent);
        setScrollModelFor(setupAgent.agentId);
        finishModelSetup(setupAgent.agentId);
        void refreshModelSummary();
      }}
    />
  );
  // Keep panel state tied to the agent. Changing selection discards its pending
  // actions and dialogs. Setup only remounts the model picker after a sign-in or save.
  const detailPanel = selected && (
    <DetailPanel
      key={selected.agentId}
      agent={selected}
      busy={!!bkSummary[selected.agentId]}
      gateway={gwSummary[selected.agentId]}
      modelMissing={needsModelSetup(mdSummary[selected.agentId])}
      modelRevision={modelRevisions[selected.agentId] ?? 0}
      onSetupModel={() => openSetup(selected.agentId)}
      onDeleted={handleAgentDeleted}
      onChanged={load}
      onModelSaved={() => modelSaved(selected.agentId)}
      onAccessChanged={refreshDeviceSummary}
      onActivity={notifyActivity}
      onRestarted={boostGateway}
    />
  );

  const tokenSection = (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', flexShrink: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: '0.06em', color: 'var(--violet)', marginBottom: 6, textTransform: 'uppercase' }}>
        Gateway Token
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, lineHeight: 1.4 }}>
        Shared token injected into all agent containers as OPENCLAW_GATEWAY_TOKEN. Agents use it to protect their OpenClaw Gateway.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <PasswordInput
          value={gatewayToken}
          onChange={setGatewayToken}
          placeholder="Gateway Token"
          disabled={tokenSaving || tokenLoading}
          showGenerate
          style={{ flex: '1 1 280px', minWidth: 180 }}
        />
        <Button variant="primary" size="sm" loading={tokenSaving} disabled={tokenLoading || !gatewayToken.trim()} onClick={saveToken}>
          {tokenSaving ? 'Saving...' : 'Save & Sync'}
        </Button>
      </div>
      {tokenStatus && (
        <div style={{ marginTop: 8, fontSize: 11, color: tokenStatus.type === 'success' ? 'var(--green)' : 'var(--red)' }}>
          {tokenStatus.message}
        </div>
      )}
    </div>
  );

  if (loading) {
    return (
      <div style={{ padding: 14, display: 'grid', gap: 14 }}>
        {lifecycleFeedback}
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', background: 'var(--bg2)', padding: 12 }}>
            <SkeletonLines count={4} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        {lifecycleFeedback}
        <div style={{ color: '#ef4444', fontSize: 14, marginBottom: 10 }}>{error}</div>
        <Button variant="secondary" size="sm" onClick={() => load()}>
          RETRY
        </Button>
      </div>
    );
  }

  // ─── Mobile: show list or detail ───
  if (isMobile) {
    if (!showList && selected) {
      return (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', display: 'flex', flexDirection: 'column' }}>
          {lifecycleFeedback}
          {setupModal}
          {/* Mobile header back - fixed top */}
          <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onClick={backToList}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M9 2L4 7l5 5"/></svg>
              BACK
            </Button>
            <span style={{ fontSize: 12, color: 'var(--violet)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.displayName || selected.name}</span>
          </div>
          {/* One scrolling region: banners and the detail scroll together, the header stays put. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', paddingBottom: FLOATING_CLEARANCE }} data-testid="agent-detail-scroll">
            <ImageDownloadBanner onImageReady={handleImageReady} />
            {providersConfigured === false && <NoProviderBanner />}
            {detailPanel}
          </div>
        </div>
      );
    }

    // Mobile: list
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', display: 'flex', flexDirection: 'column' }}>
        {lifecycleFeedback}
        {setupModal}
        <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--font-serif-stack)', fontSize: '20px', letterSpacing: '4px', color: 'var(--violet)' }}>AGENTS</span>
          <span style={{ fontSize: 11, color: '#888' }}>{agents.length}</span>
          <Button variant="primary" size="sm" disabled={!imageReady} onClick={() => router.push('/agents/create')} title={!imageReady ? 'Agent base image not built yet' : undefined}>
            + NEW
          </Button>
        </div>
        <div style={{ padding: '8px 14px', display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {(['all', 'running', 'exited'] as const).map((f) => (
            <Button key={f} variant={filter === f ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>
              {f}
            </Button>
          ))}
        </div>
        {/* One scrolling region: banners, the gateway token form, then the list. Header and filters stay put; the form scrolls away with the rest. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', paddingBottom: FLOATING_CLEARANCE }} data-testid="agents-list-scroll">
          <ImageDownloadBanner onImageReady={handleImageReady} />
          {providersConfigured === false && <NoProviderBanner />}
          {tokenSection}
          {filtered.length === 0 && <div style={{ padding: 14, color: '#888', fontSize: 12 }}>No agents found</div>}
          {filtered.map((agent) => (
            <AgentListItem
              key={agent.id}
              agent={agent}
              loading={lifecycleLoading === agent.agentId}
              channelSummary={chSummary}
              modelSummary={mdSummary}
              deviceSummary={dvSummary}
              backupSummary={bkSummary}
              gatewaySummary={gwSummary}
              busy={!!bkSummary[agent.agentId] || !!lifecycleLoading || !!startPrompt}
              onClick={() => selectAgent(agent)}
              onLifecycle={() => handleLifecycle(agent)}
              onSetupModel={() => openSetup(agent.agentId)}
            />
          ))}
        </div>
      </div>
    );
  }

  // ─── Desktop: split view ───
  return (
    <div style={{ flex: 1, background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono-stack)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {lifecycleFeedback}
      {setupModal}
      <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'var(--font-serif-stack)', fontSize: '20px', letterSpacing: '4px', color: 'var(--violet)' }}>AGENTS</span>
          <span style={{ fontSize: 11, color: '#888' }}>{agents.length} agents · {agents.filter((a) => a.state === 'running').length} running</span>
          <Button variant="primary" size="sm" disabled={!imageReady} onClick={() => router.push('/agents/create')} title={!imageReady ? 'Agent base image not built yet' : undefined}>
            + NEW
          </Button>
        </div>
      </div>
      <div style={{ padding: '8px 14px', display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {(['all', 'running', 'exited'] as const).map((f) => (
          <Button key={f} variant={filter === f ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>
            {f}
          </Button>
        ))}
      </div>
      <ImageDownloadBanner onImageReady={handleImageReady} />
      {providersConfigured === false && <NoProviderBanner />}
      {tokenSection}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: '38%', minWidth: 300, borderRight: '1px solid var(--border)', overflow: 'auto' }}>
          {filtered.length === 0 && <div style={{ padding: 14, color: '#888', fontSize: 12 }}>No agents found</div>}
          {filtered.map((agent) => {
            // Match on agentId, not the container id: recreate gives the agent a
            // new container (new id) and would otherwise silently deselect it.
            const isSelected = selectedId === agent.agentId;

            return (
              <AgentListItem
                key={agent.id}
                agent={agent}
                loading={lifecycleLoading === agent.agentId}
                channelSummary={chSummary}
                modelSummary={mdSummary}
                deviceSummary={dvSummary}
                backupSummary={bkSummary}
                gatewaySummary={gwSummary}
                busy={!!bkSummary[agent.agentId] || !!lifecycleLoading || !!startPrompt}
                selected={isSelected}
                onClick={() => selectAgent(agent)}
                onLifecycle={() => handleLifecycle(agent)}
                onSetupModel={() => openSetup(agent.agentId)}
              />
            );
          })}
        </div>
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg2)', padding: 16 }}>
          {detailPanel ?? (
            <div style={{ color: '#666', fontSize: 12, padding: 20 }}>Select an agent for details</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Edit Agent modal ───

/** The host range an agent publishes for its gateway (container ports 3000+), e.g. "3710-3719". */
function currentPortRange(ports: string): string {
  const hosts = (ports || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [host, container] = p.split(':');
      const c = parseInt((container || '').replace(/\/.*$/, ''), 10);
      return Number.isInteger(c) && c >= 3000 ? parseInt(host, 10) : NaN;
    })
    .filter((n): n is number => Number.isInteger(n));
  if (hosts.length === 0) return '';
  const min = Math.min(...hosts);
  const max = Math.max(...hosts);
  return min === max ? `${min}` : `${min}-${max}`;
}

/** The agent's own published host ports, from the `3700:3000, 3701:3001` string. */
function ownHostPorts(ports: string): number[] {
  return (ports || '')
    .split(',')
    .map((p) => parseInt(p.trim().split(':')[0] ?? '', 10))
    .filter((n) => Number.isInteger(n));
}

function EditAgentModal({ agent, onClose, onSaved, onStarted }: {
  agent: Agent;
  onClose: () => void;
  /** Rename succeeded — the parent refetches so the new name propagates. */
  onSaved: () => void;
  /** The edit job started — show the EDITING chip at once. */
  onStarted?: () => void;
}) {
  const initialName = agent.displayName || agent.name;
  const initialPorts = currentPortRange(agent.ports);
  const ownPorts = useMemo(() => ownHostPorts(agent.ports), [agent.ports]);
  const [displayName, setDisplayName] = useState(initialName);
  const [portRange, setPortRange] = useState(initialPorts);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // The ports other containers hold, fetched when the panel opens: the same set the
  // create form gets as a page prop, from the same lookup (`GET /api/agents/ports`).
  const [usedPorts, setUsedPorts] = useState<Set<number> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/agents/ports', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { ports?: number[] } | null) => {
        if (data && Array.isArray(data.ports)) setUsedPorts(new Set(data.ports));
      })
      .catch((e: unknown) => { if ((e as Error)?.name !== 'AbortError') setUsedPorts(null); });
    return () => controller.abort();
  }, []);

  // The same rules and messages as agent creation (lib/agent-ports.ts). This agent's own
  // block is excluded, so keeping or shifting it is not a conflict with itself; every
  // other container counts, running or stopped.
  const nameError = displayName.trim() ? '' : 'Display name must not be empty';
  const portError = useMemo(() => {
    if (!portRange.trim()) return '';
    const others = new Set(usedPorts ?? []);
    for (const p of ownPorts) others.delete(p);
    const r = validatePortInput(portRange, others);
    return r.valid ? '' : r.error;
  }, [portRange, usedPorts, ownPorts]);

  const nameChanged = displayName.trim() !== initialName;
  const portsChanged = portRange.trim() !== initialPorts;
  const nothingChanged = !nameChanged && !portsChanged;

  const handleSave = async () => {
    if (nothingChanged) {
      setError('Nothing to change');
      return;
    }
    if (nameError || portError) {
      setError('');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body: { displayName?: string; portRange?: string } = {};
      if (nameChanged) body.displayName = displayName.trim();
      if (portsChanged) body.portRange = portRange.trim();
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.agentId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update');
      // The job is async (202): show the chip now, and refetch the list so the new
      // display name propagates once the rebuild finishes.
      onStarted?.();
      onSaved();
      onClose();
    } catch (e: unknown) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <>
      <div
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }}
        onClick={saving ? undefined : onClose}
      >
        <div
          style={{
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 0,
            maxWidth: 400, width: '100%', maxHeight: '90vh', overflow: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 500, color: 'var(--violet)', letterSpacing: '0.05em' }}>
            <span>EDIT AGENT</span>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>✕</Button>
          </div>
          <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Input
                label="Display Name"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setError(''); }}
                placeholder="My Agent 🚀"
                error={nameError}
                disabled={saving}
              />
            </div>
            <div>
              <Input
                label="Host Port"
                value={portRange}
                onChange={(e) => { setPortRange(e.target.value.replace(/[^0-9-]/g, '').slice(0, 11)); setError(''); }}
                placeholder="3700-3709"
                error={portError}
                disabled={saving}
              />
              <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>
                Port range (e.g. 3700-3709) or single port (e.g. 3700). Maps onto the container's port 3000; the Control UI URL changes with it.
              </div>
            </div>
            <div style={{ fontSize: 10, color: '#666' }}>
              Container: {agent.name} · This recreates the container without a backup. Sessions and workspace are preserved.
            </div>
            {error && <div style={{ fontSize: 11, color: '#ef4444' }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !!nameError || !!portError}>
                {saving ? 'Saving...' : 'Save & Recreate'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Config modal ───
function ConfigModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/agents/config-json?name=${agent.name}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
        setRaw(JSON.stringify(data.config, null, 2));
      } catch (e: unknown) {
        setErr((e as Error).message || 'Failed to load config');
      } finally {
        setLoading(false);
      }
    })();
  }, [agent.name]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.65)', padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 800, width: '100%', maxHeight: '85vh',
          background: '#111', border: '1px solid var(--border)',
          borderRadius: 0, display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 14px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--violet)' }}>openclaw.json - {agent.displayName || agent.agentId || agent.name}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
          {loading && (
            <div style={{ textAlign: 'center', color: '#888', fontSize: 12, padding: 20 }}>Loading config...</div>
          )}
          {err && (
            <div style={{ color: '#ef4444', fontSize: 12 }}>{err}</div>
          )}
          {raw && (
            <pre style={{
              margin: 0, fontSize: 11, lineHeight: 1.5, color: '#ccc',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              fontFamily: 'var(--font-mono-stack)',
            }}>{raw}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Detail panel (shared between mobile & desktop) ───
/* ─── Edit banner - shown while a rename/port change rebuilds the container ─── */

interface EditJob {
  status: 'rebuilding' | 'done' | 'failed' | 'interrupted';
  displayName: string | null;
  portRange: string | null;
  error: string | null;
}

/**
 * Visible while `PATCH /api/agents/[id]` is rebuilding the container, and resumed on
 * mount so a reload or a navigation shows the running edit instead of allowing a second.
 * The server answers 409 to any new edit anyway.
 */
function EditBanner({ agentId, onChanged, ping }: { agentId: string; onChanged: () => void; ping: number }) {
  const [job, setJob] = useState<EditJob | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Held in a ref: calling it must not re-run the effect (the parent may hand a new one
  // every render), which would restart the poll on every render.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    let alive = true;
    let shown = false;
    let fetching = false;
    const tick = async () => {
      if (fetching || !alive) return;
      fetching = true;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive || controller.signal.aborted) return;
        const cur: EditJob | null = data.edit ?? null;
        if (cur?.status === 'rebuilding') { shown = true; setJob(cur); return; }
        if (shown) {
          shown = false;
          setJob(cur?.error ? cur : null);
          if (cur && (cur.status === 'done' || cur.status === 'failed')) onChangedRef.current();
        }
        else setJob(cur?.error ? cur : null);
      } catch { /* aborted or transient — the next tick retries */ }
      finally { fetching = false; }
    };
    // `ping` changes when an edit is started here, so the banner appears at once; the
    // 5 s poll then keeps it fresh and clears it when the job finishes.
    void tick();
    const timer = setInterval(() => { if (alive) void tick(); }, 5000);
    return () => { alive = false; clearInterval(timer); abortRef.current?.abort(); };
  }, [agentId, ping]);

  if (!job) return null;
  if (job.status !== 'rebuilding') return <div role="status"><Badge tone={job.status === 'done' ? 'warning' : 'danger'}>{job.error}</Badge></div>;
  return (
    <div style={{
      padding: '8px 12px',
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      color: 'var(--violet)',
      background: 'rgba(146,91,252,0.08)',
      border: '1px solid rgba(146,91,252,0.25)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--violet)', animation: 'pulse 1s infinite', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
        Rebuilding the container{job.displayName ? ` as ${job.displayName}` : ''}
        <span style={{ whiteSpace: 'nowrap' }}> (the agent restarts when done)</span>
        {job.error && <span style={{ display: 'block', color: 'var(--yellow)' }}>{job.error}</span>}
      </span>
    </div>
  );
}

function DetailPanel({ agent, busy, gateway, modelMissing, modelRevision, onSetupModel, onDeleted, onChanged, onModelSaved, onAccessChanged, onActivity, onRestarted }: {
  agent: Agent;
  modelMissing: boolean;
  modelRevision: number;
  onSetupModel: () => void;
  /** The agent is gone — the parent drops it from the list. */
  onDeleted: (agentId: string) => void;
  /** The agent changed in place (renamed, recreated) — refetch the list. */
  onChanged: () => void;
  /**
   * The model changed. Narrower than `onChanged` on purpose: only the card chip
   * needs refreshing, so this avoids refetching the whole list plus the channel
   * summary for a field the parent already knows how to reload on its own.
   */
  onModelSaved: () => void;
  /** A browser was approved, rejected or revoked — refresh the list badges. */
  onAccessChanged: () => void;
  /** A long job started here — show its chip at once (page-level notifyActivity). */
  onActivity: (agentId: string, kind: 'backup' | 'restore' | 'recreate' | 'update' | 'edit') => void;
  /** The container was restarted from the panel — poll the Gateway state at once. */
  onRestarted: () => void;
  /** This agent has a long operation running: its actions are disabled. */
  busy: boolean;
  /** The Gateway state, once `/api/agents/gateway` has answered. */
  gateway?: GatewayInfo;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  /** Bumped when an edit starts here, so the banner refetches at once. */
  const [editPing, setEditPing] = useState(0);
  /** Bumped by the Backup section after a delete, restore or backup: the update section re-reads whether its rollback backup exists. */
  const [backupsChanged, setBackupsChanged] = useState(0);

  // Safe to resolve during render: this panel only mounts once the agent list has
  // been fetched client-side, so it never runs in a server render. The helper
  // guards for a missing `window` regardless.

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.agentId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setDeleteError(data.error || 'Delete failed');
        setDeleting(false);
        return;
      }
      setShowDeleteConfirm(false);
      // No setDeleting(false): the parent drops the agent and this panel
      // unmounts. Clearing state on an unmounted component would warn.
      onDeleted(agent.agentId);
    } catch (e: unknown) {
      setDeleteError((e as Error).message || 'Network error');
      setDeleting(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 600, margin: '16px auto', paddingBottom: 24 }}>
      {modelMissing && (
        <Surface compact tone="warning">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>No model. Connect a subscription or add an API key.</span>
            <ConnectSubscriptionButton onClick={onSetupModel} />
          </div>
        </Surface>
      )}
      {/* Status */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, background: STATUS_BULLET[agent.state] || '#888' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 500 }}>{agent.displayName || agent.name}</span>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => setShowEdit(true)} title={busy ? 'An operation is running on this agent' : 'Edit agent settings'}>
                ✎
              </Button>
            </div>
            <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{agent.name}</div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{agent.status}</div>
          </div>
          {agent.template && (
            <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(146,91,252,0.12)', color: 'var(--violet)', padding: '3px 8px', borderRadius: 0, border: '1px solid rgba(146,91,252,0.25)' }}>
              template: {agent.template}
            </span>
          )}
        </div>
      </div>

      {/* Rename / ports rebuild, resumed on mount */}
      <EditBanner agentId={agent.agentId} onChanged={onChanged} ping={editPing} />

      {/* Properties */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<InfoIcon size={12} />} label="PROPERTIES" />
        {([
          ['Display Name', agent.displayName || agent.name],
          ['Agent ID', agent.agentId],
          ['Container', agent.name],
          ['Image', agent.image],
          ['Tag', agent.imageTag],
          ['OpenClaw', agent.openclawVersion || 'unknown'],
          ['Template', agent.template || '-'],
          ['State', agent.state],
          ['Ports', agent.ports || '-'],
          ['Internal IP', agent.ip || '-'],
          ['Created', fmtCreated(agent.created)],
        ] as const).map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
            <span style={{ color: '#888' }}>{label}</span>
            <span style={{ color: 'var(--text)', textAlign: 'right', maxWidth: '60%', wordBreak: 'break-word' }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Channels - Telegram */}
      <ChannelSection agentId={agent.agentId} displayName={agent.displayName || agent.name} modelMissing={modelMissing} />

      {/* Browser access - open the Control UI, approve and revoke browsers */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<KeyIcon size={12} />} label="BROWSER ACCESS" />
        <div style={{ padding: '12px 14px' }}>
          {(modelMissing || (agent.state === 'running' && agent.controlPort)) && (
            <div style={{ marginBottom: 8 }}>
              {modelMissing ? <ConnectSubscriptionButton onClick={onSetupModel} /> : (
                <OpenControlUiButton agentId={agent.agentId} hostIp={agent.controlUiHostIp} publicUrl={agent.domainConfigured === false ? undefined : agent.publicUrl} label="Open Control UI ↗" gateway={gateway?.state} blocksOpen={gateway?.blocksOpen} />
              )}
              {gateway?.state === 'starting' && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>Gateway starting… <Elapsed startedAtMs={gateway.startedAtMs} /></div>
              )}
              {gateway?.state === 'not_ready' && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>Gateway not ready after 10 minutes</div>
              )}
            </div>
          )}
          <BrowserAccessSection agentId={agent.agentId} running={agent.state === 'running'} modelMissing={modelMissing} onChanged={onAccessChanged} />
        </div>
      </div>

      <PortsSection agentId={agent.agentId} bindings={agent.portBindings} running={agent.state === 'running'} gateway={gateway?.state} blocksOpen={gateway?.blocksOpen} modelMissing={modelMissing} />

      {/* Model - primary + fallbacks (moved here from the Gateway page) */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<BracesIcon size={12} />} label="MODEL" />
        <ModelSection key={modelRevision} agentId={agent.agentId} onSaved={onModelSaved} agentBusy={busy} />
      </div>

      {/* Costs - what this agent spent, as its own OpenClaw priced it */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<BracesIcon size={12} />} label="COSTS" />
        <CostSection container={agent.name} />
        <AgentSpendAlerts container={agent.name} agentId={agent.agentId} />
      </div>

      {/* Resources - what this agent's container consumes (history on the System page) */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<BracesIcon size={12} />} label="RESOURCES" />
        <ResourceSection
          container={agent.name}
          agentId={agent.agentId}
          openclawVersion={agent.openclawVersion}
          agentBusy={busy}
          onStarted={() => { setEditPing(Date.now()); onActivity(agent.agentId, 'edit'); }}
        />
      </div>

      {/* System packages - what the agent installed with apt and whether the last restore brought it back */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<BracesIcon size={12} />} label="SYSTEM PACKAGES" />
        <PackagesSection agentId={agent.agentId} />
      </div>

      {/* Config - View openclaw.json */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<BracesIcon size={12} />} label="CONFIG" />
        <div style={{ padding: '12px 14px' }}>
          <Button variant="secondary" size="sm" onClick={() => setShowConfig(true)}>
            View openclaw.json
          </Button>
          <div style={{ fontSize: 10, color: '#666', marginTop: 6 }}>
            Inspect the full container config - providers, models, auth mode.
          </div>
        </div>
      </div>

      {/* Credentials - switched on for this agent */}
      <IntegrationSection agentName={agent.name} />

      {/* Restart */}
      <RestartSection agentName={agent.agentId} displayName={agent.displayName || agent.name} hostIp={agent.controlUiHostIp} agentBusy={busy} onRestarted={onRestarted} />

      {/* Backup - persistent volume backup & restore */}
      <BackupSection agentName={agent.name} agentId={agent.agentId} agentBusy={busy} onChanged={() => setBackupsChanged((n) => n + 1)} onStarted={(kind) => onActivity(agent.agentId, kind)} />

      {/* Config modal */}
      {showConfig && <ConfigModal agent={agent} onClose={() => setShowConfig(false)} />}

      {/* Edit agent modal */}
      {showEdit && <EditAgentModal agent={agent} onClose={() => setShowEdit(false)} onSaved={onChanged} onStarted={() => { setEditPing(Date.now()); onActivity(agent.agentId, 'edit'); }} />}

      {/* Delete confirmation */}
      <ConfirmModal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => { setShowDeleteConfirm(false); handleDelete(); }}
        title={`Delete ${agent.displayName || agent.name}?`}
        message="This permanently deletes the container, its persistent volume, and ALL its backups. This cannot be undone."
        confirmLabel="Delete Agent"
        cancelLabel="Cancel"
        tone="danger"
      />

      {/* Recreate */}
      {/* OpenClaw version and the Update action */}
      <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<RotateIcon size={12} />} label="OPENCLAW VERSION" />
        <div style={{ padding: '12px 14px' }}>
          <UpdateSection backupsChanged={backupsChanged} agentId={agent.agentId} displayName={agent.displayName || agent.name} running={agent.state === 'running'} onChanged={onChanged} onStarted={() => onActivity(agent.agentId, 'update')} />
        </div>
      </div>
      <RecreateSection portsDiffer={agent.portsDiffer} hostIp={agent.controlUiHostIp} agentRunning={agent.state === 'running'} agentName={agent.name} displayName={agent.displayName || agent.name} agentBusy={busy} newBuildVersion={agent.newBuildAvailable ? agent.openclawVersion ?? null : null} onRecreated={onChanged} onStarted={() => onActivity(agent.agentId, 'recreate')} />

      {/* Delete */}
      <div style={{ border: '1px solid rgba(239,68,68,0.3)', borderRadius: 0, background: 'rgba(239,68,68,0.04)', overflow: 'hidden' }}>
        <SectionHeader icon={<TrashIcon size={12} />} label="DANGER ZONE" danger />
        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
            Permanently delete this agent: container, persistent volume, and all backups. This cannot be undone.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="danger" size="sm" loading={deleting} onClick={() => setShowDeleteConfirm(true)}>
              {deleting ? 'Deleting...' : 'Delete Agent'}
            </Button>
          </div>
          {deleteError && (
            <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{deleteError}</div>
          )}
        </div>
      </div>

      {/* Env */}
      {agent.env.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
          <SectionHeader icon={<TerminalIcon size={12} />} label="ENV (AGENT_ / MODEL_)" />
          {agent.env.map((e) => (
            <div key={e} style={{ padding: '6px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, color: '#aaa', fontFamily: 'var(--font-mono-stack)' }}>
              {e.split('=').map((v, i) => i === 1 && v.length > 0 ? `${v.slice(0, 20)}${v.length > 20 ? '...' : ''}` : v).join('=')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Credentials section - what the Credentials page switched on for this agent (read-only) ─── */

function IntegrationSection({ agentName }: { agentName: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      <SectionHeader icon={<LinkIcon size={12} />} label="CREDENTIALS" />
      <CredentialsSection agentName={agentName} />
    </div>
  );
}

/* ─── Backup section - persistent volume backup & restore (cold backup) ─── */

interface ColdBackupJob {
  status: 'running' | 'succeeded' | 'failed';
  file: string;
  kind?: string;
  percent: number | null;
  error: string | null;
}

interface RestoreJob {
  id: number;
  status: 'restoring' | 'unresolved' | 'done' | 'failed' | 'interrupted';
  file: string | null;
  error: string | null;
  phase?: string | null;
  recoveryFile?: string | null;
}

function BackupSection({ agentName, agentId, agentBusy, onStarted, onChanged }: { agentName: string; agentId: string; agentBusy?: boolean; onStarted?: (kind: 'backup' | 'restore') => void; onChanged?: () => void }) {
  const [backups, setBackups] = useState<{ name: string; size: string; date: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [backup, setBackup] = useState<ColdBackupJob | null>(null);
  const [restore, setRestore] = useState<RestoreJob | null>(null);
  /** The one action in flight, and the file it is working on (keyed busy state). */
  const [busy, setBusy] = useState<{ kind: 'starting' | 'cancelling' | 'restoring' | 'resolving' | 'checking-delete' | 'deleting'; file?: string } | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [resolveConfirm, setResolveConfirm] = useState<number | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  /** The file whose Delete is being confirmed, and the rollback it would make impossible (if any). */
  const [deleteConfirm, setDeleteConfirm] = useState<{ file: string; rollbackTo: string | null } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const lifecycleRef = useRef({ generation: 0, mounted: false });
  const isCurrent = useCallback((generation: number) =>
    lifecycleRef.current.mounted && lifecycleRef.current.generation === generation, []);
  const actionRef = useRef<{ generation: number; action: NonNullable<typeof busy> } | null>(null);
  const beginAction = useCallback((action: NonNullable<typeof busy>) => {
    const generation = lifecycleRef.current.generation;
    if (!isCurrent(generation) || actionRef.current) return null;
    const claim = { generation, action };
    actionRef.current = claim;
    setBusy(action);
    return claim;
  }, [isCurrent]);
  const endAction = useCallback((claim: NonNullable<typeof actionRef.current>) => {
    if (actionRef.current !== claim) return;
    actionRef.current = null;
    if (isCurrent(claim.generation)) setBusy(null);
  }, [isCurrent]);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    const generation = lifecycleRef.current.generation;
    if (!isCurrent(generation)) return;
    setToast({ msg, type });
    setTimeout(() => { if (isCurrent(generation)) setToast(null); }, 4000);
  };

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
  }, []);

  const loadBackups = useCallback(async () => {
    const generation = lifecycleRef.current.generation;
    if (!isCurrent(generation)) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentName}/backup`, { signal: controller.signal });
      if (res.ok && !controller.signal.aborted && abortRef.current === controller) {
        const data: { backups: { name: string; size: string; date: string }[] } = await res.json();
        if (!isCurrent(generation) || controller.signal.aborted || abortRef.current !== controller) return;
        setBackups(data.backups ?? []);
      }
    } catch { /* aborted or transient — the list stays as it is */ }
    if (isCurrent(generation) && abortRef.current === controller) setLoading(false);
  }, [agentName, isCurrent]);

  /* Poll a running job every 2s until it finishes; the job lives in Docker
     (a detached helper container), so this resumes cleanly after a reload. */
  const startPolling = useCallback(() => {
    const generation = lifecycleRef.current.generation;
    if (!isCurrent(generation)) return;
    stopPolling();
    pollRef.current = setInterval(async () => {
      if (!isCurrent(generation)) return;
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;
      try {
        const res = await fetch(`/api/agents/${agentName}/cold-backup`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (!isCurrent(generation) || pollAbortRef.current !== controller || controller.signal.aborted) return;
        const job: ColdBackupJob | null = data.backup ?? null;
        if (job?.status === 'running') {
          setBackup(job);
          return;
        }
        stopPolling();
        setBackup(null);
        if (job?.status === 'succeeded') showToast('Backup completed: ' + job.file);
        else if (job?.status === 'failed') showToast('Backup failed: ' + (job.error ?? 'unknown error'), 'error');
        await loadBackups();
        if (isCurrent(generation)) onChanged?.();
      } catch { /* aborted or transient network error — the next tick retries */ }
    }, 2000);
  }, [agentName, isCurrent, loadBackups, stopPolling]);

  /* Poll a running restore every 2s; the job is recorded server-side, so this resumes
     after a reload and a second restore cannot start meanwhile (the server answers 409). */
  const startRestorePolling = useCallback(() => {
    const generation = lifecycleRef.current.generation;
    if (!isCurrent(generation)) return;
    stopPolling();
    pollRef.current = setInterval(async () => {
      if (!isCurrent(generation)) return;
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;
      try {
        const res = await fetch(`/api/agents/${agentName}/restore`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (!isCurrent(generation) || pollAbortRef.current !== controller || controller.signal.aborted) return;
        const job: RestoreJob | null = data.restore ?? null;
        if (job?.status === 'restoring') {
          setRestore(job);
          return;
        }
        stopPolling();
        setRestore(job);
        if (job?.status === 'done') showToast('Restored from ' + (job.file ?? 'the backup'));
        else if (job?.status === 'failed' || job?.status === 'unresolved') showToast('Restore failed: ' + (job.error ?? 'unknown error'), 'error');
        await loadBackups();
      } catch { /* aborted or transient network error — the next tick retries */ }
    }, 2000);
  }, [agentName, isCurrent, loadBackups, stopPolling]);

  /* On mount: load the archive list and pick up a backup or restore already running. */
  useEffect(() => {
    const generation = lifecycleRef.current.generation + 1;
    lifecycleRef.current = { generation, mounted: true };
    actionRef.current = null;
    const controller = new AbortController();
    setRestore(null);
    setBackup(null);
    setBusy(null);
    setToast(null);
    setRestoreConfirm(null);
    setResolveConfirm(null);
    setDeleteConfirm(null);
    void loadBackups();
    void (async () => {
      try {
        // A restore's cold recovery copy belongs to that restore, not a separate backup action.
        const rRes = await fetch(`/api/agents/${agentName}/restore`, { signal: controller.signal });
        if (rRes.ok && isCurrent(generation)) {
          const rData = await rRes.json();
          if (!isCurrent(generation)) return;
          setRestore(rData.restore ?? null);
          if (rData.restore?.status === 'restoring') {
            startRestorePolling();
            return;
          }
        }
        if (!isCurrent(generation)) return;
        const res = await fetch(`/api/agents/${agentName}/cold-backup`, { signal: controller.signal });
        if (res.ok && isCurrent(generation)) {
          const data = await res.json();
          if (!isCurrent(generation)) return;
          if (data.backup?.status === 'running') {
            setBackup(data.backup);
            startPolling();
            return;
          }
        }
      } catch { /* ignore */ }
    })();
    return () => {
      lifecycleRef.current = { generation: generation + 1, mounted: false };
      actionRef.current = null;
      controller.abort();
      abortRef.current?.abort();
      stopPolling();
    };
  }, [agentName, isCurrent, startPolling, startRestorePolling, stopPolling, loadBackups]);

  const handleBackup = async () => {
    const claim = beginAction({ kind: 'starting' });
    if (!claim) return;
    const { generation } = claim;
    try {
      const res = await fetch(`/api/agents/${agentName}/cold-backup`, { method: 'POST' });
      const data = await res.json();
      if (!isCurrent(generation)) return;
      if (res.status === 202 && data.started) {
        setBackup({ status: 'running', file: data.file, percent: null, error: null });
        onStarted?.('backup');
        startPolling();
      } else {
        showToast(data.error || 'Backup failed to start', 'error');
      }
    } catch (e: unknown) {
      if (isCurrent(generation)) showToast((e as Error).message, 'error');
    } finally {
      endAction(claim);
    }
  };

  const handleCancelBackup = async () => {
    const claim = beginAction({ kind: 'cancelling' });
    if (!claim) return;
    const { generation } = claim;
    try {
      const res = await fetch(`/api/agents/${agentName}/cold-backup`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!isCurrent(generation)) return;
      if (!res.ok) {
        showToast(data.error || 'Cancel failed', 'error');
      } else {
        stopPolling();
        setBackup(null);
        showToast('Backup cancelled');
        await loadBackups();
      }
    } catch (e: unknown) {
      if (isCurrent(generation)) showToast((e as Error).message, 'error');
    } finally {
      endAction(claim);
    }
  };

  const executeRestore = async () => {
    const file = restoreConfirm;
    if (!file) return;
    const claim = beginAction({ kind: 'restoring', file });
    if (!claim) return;
    const { generation } = claim;
    setRestoreConfirm(null);
    try {
      const res = await fetch(`/api/agents/${agentName}/restore?file=${encodeURIComponent(file)}`, { method: 'POST' });
      const data = await res.json();
      if (!isCurrent(generation)) return;
      if (res.status === 202 && data.started) {
        setRestore({ id: data.id, status: 'restoring', file, error: null });
        onStarted?.('restore');
        onChanged?.();
        startRestorePolling();
      } else {
        showToast(data.error || 'Restore failed to start', 'error');
      }
    } catch (e: unknown) {
      if (isCurrent(generation)) showToast((e as Error).message, 'error');
    } finally {
      endAction(claim);
    }
  };

  /** Ask before deleting; when this is the backup the latest update's Roll back needs, say so. */
  const askDeleteBackup = async (file: string) => {
    const claim = beginAction({ kind: 'checking-delete', file });
    if (!claim) return;
    const { generation } = claim;
    let rollbackTo: string | null = null;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/update`, { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { update?: { backupFile: string | null; fromVersion: string | null; status: string; resolvedAtMs: number | null; backupAvailable: boolean | null } | null };
        const u = data.update;
        const offered = !!u && u.backupFile === file && !!u.fromVersion && u.backupAvailable !== false
          && ['done', 'failed', 'interrupted', 'rollback_failed'].includes(u.status);
        if (offered && u) rollbackTo = u.fromVersion;
      }
    } catch { /* unknown: the plain confirmation */ }
    if (isCurrent(generation)) setDeleteConfirm({ file, rollbackTo });
    endAction(claim);
  };

  const handleDeleteBackup = async (file: string) => {
    const claim = beginAction({ kind: 'deleting', file });
    if (!claim) return;
    const { generation } = claim;
    try {
      const res = await fetch(`/api/agents/${agentName}/backup?file=${encodeURIComponent(file)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!isCurrent(generation)) return;
      if (!res.ok || !data.success) {
        showToast(data.error || 'Delete failed', 'error');
      }
      await loadBackups();
      if (isCurrent(generation)) onChanged?.();
    } catch (e: unknown) {
      if (isCurrent(generation)) showToast((e as Error).message, 'error');
    } finally {
      endAction(claim);
    }
  };

  const handleResolveRestore = async (restoreId: number) => {
    const claim = beginAction({ kind: 'resolving' });
    if (!claim) return;
    const { generation } = claim;
    try {
      const res = await fetch(`/api/agents/${agentName}/restore/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restoreId }),
      });
      const data = await res.json();
      if (!isCurrent(generation)) return;
      if (!res.ok) { showToast(data.error ?? 'Restore resolution failed; reservation retained', 'error'); return; }
      setRestore(data.restore ?? null);
      showToast('Restore reservation released. Review the current volume before starting the agent.');
      await loadBackups();
      if (isCurrent(generation)) onChanged?.();
    } catch (error) {
      if (isCurrent(generation)) showToast((error as Error).message, 'error');
    } finally { endAction(claim); }
  };

  const running = backup?.status === 'running';
  const restoring = restore?.status === 'restoring';
  const actionsLocked = running || restoring || restore?.status === 'unresolved' || busy !== null || !!agentBusy;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      <SectionHeader icon={<ArchiveIcon size={12} />} label="BACKUP" />
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {restore?.status === 'done' && restore.phase !== 'complete' && (
          <div role="status" style={{ fontSize: 11, color: 'var(--yellow)' }}>
            This older restore did not record Gateway readiness. Check the agent's current status before relying on the restored data.
          </div>
        )}
        {(restore?.status === 'failed' || restore?.status === 'interrupted' || restore?.status === 'unresolved') && (
          <div role="status" style={{ fontSize: 11, color: 'var(--yellow)', overflowWrap: 'anywhere' }}>
            Restore needs attention: {restore.error ?? 'Check the agent and its backup before retrying.'}
            {restore.recoveryFile && !restore.error?.includes(restore.recoveryFile) && <> Recovery backup: {restore.recoveryFile}.</>}
          </div>
        )}
        {restore?.status === 'unresolved' && (
          <Button variant="secondary" size="sm" disabled={busy !== null || running || restoring}
            loading={busy?.kind === 'resolving'} onClick={() => setResolveConfirm(restore.id)}>
            {busy?.kind === 'resolving' ? 'Resolving…' : 'Resolve restore'}
          </Button>
        )}
        {running && (
          <div style={{
            padding: '8px 12px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--violet)',
            background: 'rgba(146,91,252,0.08)',
            border: '1px solid rgba(146,91,252,0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <span style={{
              display: 'inline-block',
              width: 8, height: 8,
              borderRadius: '50%',
              background: 'var(--violet)',
              animation: 'pulse 1s infinite',
              flexShrink: 0,
            }} />
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
              Backing up {backup?.file}
              {/* Inline and nowrap: the file name may break, but the percentage and the
                  note move to the next line as one piece instead of splitting "5" / "3%". */}
              <span style={{ whiteSpace: 'nowrap' }}>
                {' '}{backup?.percent !== null && backup?.percent !== undefined ? `— ${backup.percent}% ` : ''}(the agent restarts when done)
              </span>
            </span>
            <span style={{ flexShrink: 0 }}>
              <Button
                variant="secondary"
                size="sm"
                loading={busy?.kind === 'cancelling'}
                disabled={busy !== null}
                onClick={handleCancelBackup}
              >
                {busy?.kind === 'cancelling' ? 'Cancelling…' : 'Cancel'}
              </Button>
            </span>
          </div>
        )}
        {restoring && (
          <div style={{
            padding: '8px 12px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--violet)',
            background: 'rgba(146,91,252,0.08)',
            border: '1px solid rgba(146,91,252,0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <span style={{
              display: 'inline-block',
              width: 8, height: 8,
              borderRadius: '50%',
              background: 'var(--violet)',
              animation: 'pulse 1s infinite',
              flexShrink: 0,
            }} />
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
              {restore?.phase === 'preflight' ? 'Checking backup' : restore?.phase === 'backing_up' ? 'Saving current state before restore' : restore?.phase === 'awaiting_ready' ? 'Waiting for the restored Gateway' : 'Restoring'} {restore?.file}
              <span style={{ whiteSpace: 'nowrap' }}> (completion requires a ready Gateway)</span>
            </span>
          </div>
        )}
        {loading && backups.length === 0 && <div style={{ fontSize: 11, color: '#888' }}>Loading...</div>}
        {!loading && backups.length === 0 && (
          <div style={{ fontSize: 11, color: '#888' }}>No backups yet.</div>
        )}
        {backups.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {backups.map((b) => (
              // Wraps instead of crushing the name: the name asks for a 220px basis and
              // grows; when the row can no longer fit size, date and the buttons beside
              // it, they move to a second line rather than squeezing the name to one
              // character per line.
              <div key={b.name} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'var(--font-mono)', padding: '4px 0' }}>
                <span style={{ flex: '1 1 220px', minWidth: 0, color: 'var(--text)', wordBreak: 'break-all' }}>{b.name}</span>
                <span style={{ color: '#888', whiteSpace: 'nowrap', flexShrink: 0 }}>{b.size}</span>
                <span style={{ color: '#666', whiteSpace: 'nowrap', flexShrink: 0 }}>{b.date}</span>
                <span style={{ display: 'flex', gap: 8, flexShrink: 0, marginLeft: 'auto' }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={actionsLocked}
                    loading={busy?.kind === 'restoring' && busy.file === b.name}
                    onClick={() => setRestoreConfirm(b.name)}
                  >
                    {busy?.kind === 'restoring' && busy.file === b.name ? 'Restoring…' : 'Restore'}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={actionsLocked}
                    loading={(busy?.kind === 'checking-delete' || busy?.kind === 'deleting') && busy.file === b.name}
                    onClick={() => { void askDeleteBackup(b.name); }}
                  >
                    {busy?.file === b.name && busy.kind === 'checking-delete' ? 'Checking…' : busy?.file === b.name && busy.kind === 'deleting' ? 'Deleting…' : 'Delete'}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" size="sm" disabled={actionsLocked} loading={busy?.kind === 'starting'} onClick={handleBackup}>
            {busy?.kind === 'starting' ? 'Starting…' : 'Backup Now'}
          </Button>
        </div>
      </div>
      {toast && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 11, color: toast.type === 'success' ? '#22c55e' : '#ef4444' }}>
          {toast.msg}
        </div>
      )}
      <ConfirmModal
        open={resolveConfirm !== null}
        onClose={() => setResolveConfirm(null)}
        onConfirm={() => { const id = resolveConfirm; setResolveConfirm(null); if (id !== null) void handleResolveRestore(id); }}
        title="Resolve Restore"
        message="Stop and remove only this restore's labelled extraction helpers and release its reservation? The agent container is left untouched. The volume may contain partial data: review it before starting the agent or restoring the recovery backup."
        confirmLabel="Resolve restore"
        tone="warning"
      />
      <ConfirmModal
        open={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={() => { const file = deleteConfirm?.file; setDeleteConfirm(null); if (file) void handleDeleteBackup(file); }}
        title="Delete Backup"
        message={`Delete ${deleteConfirm?.file ?? ''}? This cannot be undone.` +
          (deleteConfirm?.rollbackTo ? `\n\nThis is the backup the Roll back to OpenClaw ${deleteConfirm.rollbackTo} needs: after deleting it you can no longer go back.` : '')}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        tone="danger"
      />
      <ConfirmModal
        open={restoreConfirm !== null}
        onClose={() => setRestoreConfirm(null)}
        onConfirm={executeRestore}
        title="Restore Backup"
        message={`Restore from ${restoreConfirm || ''}?\n\nThe agent container will be stopped, restored, and restarted.`}
        confirmLabel="Restore"
        cancelLabel="Cancel"
        tone="warning"
      />
    </div>
  );
}

/* ─── Restart section - simple container restart ─── */

function RestartSection({ agentName, displayName, hostIp, agentBusy, onRestarted }: {
  agentName: string; displayName: string; hostIp?: string | null; agentBusy?: boolean; onRestarted: () => void;
}) {
  const [restarting, setRestarting] = useState(false);
  const restartingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [startPrompt, setStartPrompt] = useState<AgentStartPrompt | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  };

  const handleRestart = async () => {
    if (restartingRef.current || startPrompt) return;
    restartingRef.current = true;
    setRestarting(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/restart`, { method: 'POST', signal: controller.signal });
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (res.status === 409 && data.code === 'ports_differ') {
        setStartPrompt({ agentId: agentName, name: displayName, hostIp, setting: data.setting });
      } else if (res.ok && data.success) {
        showToast('Container restarted');
        onRestarted();
      } else {
        showToast(data.error || 'Restart failed');
      }
    } catch (e: unknown) {
      if (!controller.signal.aborted && (e as Error).name !== 'AbortError') showToast((e as Error).message || 'Network error');
    } finally {
      restartingRef.current = false;
      if (!controller.signal.aborted) setRestarting(false);
    }
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      <SectionHeader icon={<RotateIcon size={12} />} label="RESTART" />
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
          Restart the container without losing any data.
        </div>
        <Button variant="secondary" size="sm" loading={restarting} disabled={restarting || !!startPrompt || !!agentBusy} onClick={handleRestart}>
          {restarting ? 'Restarting…' : 'Restart Container'}
        </Button>
      </div>
      {startPrompt && <AgentStartDialog prompt={startPrompt} onClose={() => setStartPrompt(null)}
        onStarted={onRestarted} onComplete={() => { setStartPrompt(null); onRestarted(); }} />}
      {toast && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 11, color: '#22c55e' }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/* ─── Recreate section - rebuild container on the current build of its version, keeping the volume ─── */

interface RecreateJob {
  status: 'backing_up' | 'recreating' | 'done' | 'failed' | 'interrupted';
  image: string | null;
  backupFile: string | null;
  backupPercent: number | null;
  error: string | null;
}

function RecreateSection({ agentName, displayName, agentBusy, portsDiffer, hostIp, agentRunning, newBuildVersion = null, onRecreated, onStarted }: {
  portsDiffer?: boolean;
  hostIp?: string | null;
  agentRunning?: boolean;
  agentName: string;
  /** The agent display name, for texts the user reads; agentName is the container, for URLs. */
  displayName?: string;
  /** The OpenClaw version of this agent when a newer build of it is downloaded (the NEW BUILD badge): the section says so. */
  newBuildVersion?: string | null;
  /** A long operation is running on this agent. */
  agentBusy?: boolean;
  /** The container was rebuilt — the parent refetches (new id, fresh image). */
  onRecreated: () => void;
  /** The recreate job started — show the RECREATING chip at once. */
  onStarted?: () => void;
}) {
  const [job, setJob] = useState<RecreateJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seenDone = useRef(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  };

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    abortRef.current?.abort();
  }, []);

  /* Poll the job every 2s while it runs. The job is recorded in `agent_recreates`
     and the steps run in the Rev4a process, so a reload resumes from the row. */
  const startPolling = useCallback(() => {
    stopPolling();
    let fetching = false;
    pollRef.current = setInterval(async () => {
      if (fetching) return;
      fetching = true;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/agents/${agentName}/recreate`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        const current: RecreateJob | null = data.recreate ?? null;
        if (controller.signal.aborted) return;
        setWarning(current?.status !== 'failed' && current?.status !== 'interrupted' ? current?.error ?? null : null);
        if (current && (current.status === 'backing_up' || current.status === 'recreating')) {
          setJob(current);
          return;
        }
        stopPolling();
        setJob(null);
        if (current?.status === 'done') {
          if (!seenDone.current) {
            seenDone.current = true;
            showToast('Container recreated successfully');
            onRecreated();
          }
        } else if (current?.status === 'failed' || current?.status === 'interrupted') {
          setError(current.error || 'Recreate failed');
        }
      } catch { /* aborted or transient network error — the next tick retries */ }
      finally { fetching = false; }
    }, 2000);
  }, [agentName, onRecreated, stopPolling]);

  /* On mount: pick up a recreate that is already running. */
  useEffect(() => {
    let alive = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        const res = await fetch(`/api/agents/${agentName}/recreate`, { signal: controller.signal });
        if (res.ok && alive) {
          const data = await res.json();
          if (!alive || controller.signal.aborted) return;
          setWarning(data.recreate?.status !== 'failed' && data.recreate?.status !== 'interrupted' ? data.recreate?.error ?? null : null);
          if (data.recreate?.status === 'failed' || data.recreate?.status === 'interrupted') {
            setError(data.recreate.error || 'Recreate failed');
          }
          if (data.recreate && (data.recreate.status === 'backing_up' || data.recreate.status === 'recreating')) {
            setJob(data.recreate);
            startPolling();
          }
        }
      } catch { /* ignore */ }
    })();
    return () => { alive = false; stopPolling(); };
  }, [agentName, startPolling, stopPolling]);

  const handleRecreate = async () => {
    setShowConfirm(false);
    // A discovery read still in flight describes the previous job: it must not paint its
    // failure over this new run (abortRef is the mount discovery's controller here).
    abortRef.current?.abort();
    setStarting(true);
    setError('');
    setWarning(null);
    try {
      const res = await fetch(`/api/agents/${agentName}/recreate`, { method: 'POST' });
      const data = await res.json();
      if (res.status === 202 && data.started) {
        seenDone.current = false;
        setJob({ status: 'backing_up', image: null, backupFile: null, backupPercent: null, error: null });
        onStarted?.();
        startPolling();
      } else {
        setError(data.error || 'Recreate failed');
      }
    } catch (e: unknown) {
      setError((e as Error).message || 'Network error');
    }
    setStarting(false);
  };

  const running = job !== null;


  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      <SectionHeader icon={<PackageIcon size={12} />} label="RECREATE" />
      {newBuildVersion && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--yellow)', borderBottom: '1px solid var(--border)' }}>
          ⚠ A newer build of OpenClaw {newBuildVersion} is downloaded. Recreate this agent to use it (a cold backup is taken first).
        </div>
      )}
      <div style={{ padding: '12px 14px' }}>
        {running && (
          <div style={{
            padding: '8px 12px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--violet)',
            background: 'rgba(146,91,252,0.08)',
            border: '1px solid rgba(146,91,252,0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
          }}>
            <span style={{
              display: 'inline-block',
              width: 8, height: 8,
              borderRadius: '50%',
              background: 'var(--violet)',
              animation: 'pulse 1s infinite',
              flexShrink: 0,
            }} />
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
              {job.status === 'backing_up' ? (
                <>
                  Backing up {job.backupFile ?? '…'}
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {' '}{job.backupPercent !== null ? `— ${job.backupPercent}% ` : ''}(the agent restarts when done)
                  </span>
                </>
              ) : 'Recreating container…'}
            </span>
          </div>
        )}
        <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
          Takes an automatic cold backup — the agent stops for it — then rebuilds the container on the same OpenClaw version, keeping workspace, config, credentials and state. To move to a newer OpenClaw version, use Update above.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {portsDiffer && <Pill tone="warning" title="Recreate to apply the Remote access setting">Ports: {agentPortsLabel(hostIp)}</Pill>}
          {(!portsDiffer || agentRunning) && <Button type="button" variant="secondary" size="sm" loading={running || starting} disabled={running || starting || !!agentBusy} onClick={() => setShowConfirm(true)}>
            {starting ? 'Starting…' : running ? 'Recreating…' : 'Recreate Container'}
          </Button>}
        </div>
        {error && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{error}</div>}
        {warning && <div role="status" style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 6 }}>{warning}</div>}
      </div>
      {toast && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 11, color: '#22c55e' }}>
          {toast}
        </div>
      )}
      <ConfirmModal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleRecreate}
        title="Recreate Container"
        message={`Recreate the container of "${displayName || agentName}"?\n\nAn automatic cold backup is taken first — the agent stops for it — then the container is rebuilt on the current build of its OpenClaw version (a newer build if one was downloaded). Workspace, credentials, and state are preserved in the persistent volume. If the backup fails, the recreate is aborted and the agent is started again.`}
        confirmLabel="Recreate"
        cancelLabel="Cancel"
        tone="warning"
      />
    </div>
  );
}

/* ─── Channel section - Telegram ─── */

function ChannelSection({ agentId, displayName, modelMissing }: { agentId: string; displayName: string; modelMissing: boolean }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ telegram: boolean } | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  const doFetchPreview = useCallback(() => {
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    fetch(`/api/agents/${encodeURIComponent(agentId)}/channels`, { signal: controller.signal })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setPreview({
            telegram: data.telegram?.connected === true,
          });
        }
      })
      .catch((e: any) => {
        if (e?.name !== 'AbortError') { /* ignore aborted */ }
      });
  }, [agentId]);

  useEffect(() => {
    setPreview(null);
    doFetchPreview();
    return () => { previewAbortRef.current?.abort(); };
  }, [doFetchPreview]);

  return (
    <>
      <div style={{ border: '1px solid var(--border)', borderRadius: 0, background: 'var(--bg)', overflow: 'hidden' }}>
        <SectionHeader icon={<LinkIcon size={12} />} label="CHANNELS" />
        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {preview === null ? (
              <span style={{ color: 'var(--text-dim)' }}>Loading...</span>
            ) : (
              <>
                <Badge tone={preview.telegram ? 'success' : 'neutral'}>
                  <span style={{ fontSize: 9 }}>{preview.telegram ? 'TG: Connected' : 'TG: Not Set'}</span>
                </Badge>
              </>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Manage Channels
          </Button>
        </div>
      </div>
      <ChannelManager
        agentId={agentId}
        displayName={displayName}
        modelMissing={modelMissing}
        open={open}
        onClose={() => { setOpen(false); doFetchPreview(); }}
      />
    </>
  );

}
