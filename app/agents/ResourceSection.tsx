'use client';

/**
 * Resources section of the agent detail panel: what this agent's container consumes now and
 * over the last 24 h (GET /api/metrics/containers, from metrics.db). The history charts are
 * on the System page — one place, linked from here. It also holds the agent's optional
 * memory limit: shown against its usage, set live, or removed (which rebuilds the container).
 */
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { formatMb, formatRate, formatSharePercent } from '@/lib/utils/format';
import { formatLimit } from '@/lib/agent-memory-limit';
import { Button, MemoryLimitPicker, Modal } from '../components/ui';
import { PanelRow } from './PanelRow';

interface Overview {
  available: boolean;
  interval_s: number;
  age_s?: number | null;
  containers?: {
    container: string;
    running: boolean;
    now: { cpu_cores: number | null; cpu_percent: number | null; mem_mb: number | null; mem_percent: number | null; pids: number | null; net_rx_bps: number | null; net_tx_bps: number | null } | null;
    range: { cpu_avg_percent: number | null; cpu_max_percent: number | null; mem_avg_mb: number | null; mem_max_mb: number | null };
    storage: { volume_mb: number | null; layer_mb: number | null; total_mb: number | null };
  }[];
}


interface LimitInfo {
  limitMb: number | null;
  swapMb: number | null;
  running: boolean;
  usageMb: number | null;
  dockerTotalMb: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A usage at or above this share of the limit is shown in the warning colour. */
const WARN_SHARE = 0.9;

function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

/**
 * The "Memory limit" row. Setting a limit applies live (`docker update`, no restart);
 * removing one rebuilds the container, which the page's edit banner then follows.
 * One action key at a time ('save' or 'remove'), guarded by a ref (rules 6a-6c).
 */
function MemoryLimitRow({ agentId, container, agentBusy, onStarted }: {
  agentId: string;
  container: string;
  agentBusy: boolean;
  onStarted?: () => void;
}) {
  const [info, setInfo] = useState<LimitInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [oomAt, setOomAt] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // The picker's choice: the limit in MB (null for none) and its error text.
  const [picked, setPicked] = useState<{ mb: number | null; error: string }>({ mb: null, error: '' });
  const [formError, setFormError] = useState('');
  const [confirm, setConfirm] = useState<'below' | 'remove' | null>(null);
  const [action, setAction] = useState<'save' | 'remove' | null>(null);
  const actionRef = useRef<'save' | 'remove' | null>(null);
  /** The removal rebuild was started here: follow its edit job until it ends. */
  const [removing, setRemoving] = useState(false);
  const removeJobRef = useRef<number | null>(null);
  const removingRef = useRef(false);
  removingRef.current = removing;
  /** Why the last removal did not finish, from the edit job. */
  const [removeError, setRemoveError] = useState('');
  const jobAbortRef = useRef<AbortController | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const url = `/api/agents/${encodeURIComponent(agentId)}/memory-limit`;

  const load = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const [res, alertsRes] = await Promise.all([
        apiFetch(url, { signal: controller.signal }),
        apiFetch(`/api/metrics/alerts?limit=5&container=${encodeURIComponent(container)}`, { signal: controller.signal }).catch((e) => {
          if (e?.name === 'AbortError') throw e;
          return null;
        }),
      ]);
      const body = await res.json();
      // The container is briefly absent while the removal rebuild runs: keep following the
      // edit job, whose own status decides when the wait ends (done, failed or interrupted).
      if (res.status === 404 && removingRef.current) return;
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      setInfo(body as LimitInfo);
      setLoadError('');
      if (alertsRes?.ok) {
        const alerts = ((await alertsRes.json())?.alerts ?? []) as { ts: number; metric: string | null }[];
        const latest = alerts.find((a) => a.metric === 'container_oom' && Date.now() - a.ts <= DAY_MS);
        setOomAt(latest ? latest.ts : null);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') setLoadError(e?.message || 'Could not load the memory limit');
    }
  };

  useEffect(() => {
    setInfo(null);
    setLoadError('');
    setOomAt(null);
    void load();
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, container]);

  // After a removal was started the container is being rebuilt: follow the edit job itself
  // (GET /api/agents/[id]) and stop when it is done, failed or interrupted, so a failed
  // rebuild never leaves the row waiting for ever.
  useEffect(() => {
    if (!removing) return;
    const tick = async () => {
      jobAbortRef.current?.abort();
      const controller = new AbortController();
      jobAbortRef.current = controller;
      try {
        const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { signal: controller.signal });
        if (!res.ok) return;
        const edit = (await res.json())?.edit as { id: number; status: string; error: string | null } | null;
        const ours = removeJobRef.current;
        if (!edit || (ours !== null && edit.id < ours)) return;
        // A newer edit (a rename from another tab, say) means ours has already ended: stop
        // waiting instead of sticking on "removing…"; the reload shows what the container has.
        const superseded = ours !== null && edit.id > ours;
        if (!superseded && edit.status === 'rebuilding') return;
        removeJobRef.current = null;
        setRemoving(false);
        if (!superseded && edit.status !== 'done') {
          setRemoveError(edit.error || (edit.status === 'interrupted' ? 'The rebuild was interrupted: the memory limit may still be set.' : 'The rebuild failed.'));
        }
        void load();
      } catch { /* aborted or transient: the next tick retries */ }
    };
    const timer = setInterval(() => { void tick(); }, 5_000);
    return () => {
      clearInterval(timer);
      jobAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removing, agentId, container]);

  const begin = (key: 'save' | 'remove'): boolean => {
    if (actionRef.current) return false;
    actionRef.current = key;
    setAction(key);
    setFormError('');
    setRemoveError('');
    // A poll still in flight must not overwrite what this action is about to write.
    abortRef.current?.abort();
    return true;
  };
  const end = () => {
    actionRef.current = null;
    setAction(null);
  };

  const openForm = () => {
    setPicked({ mb: info?.limitMb ?? null, error: '' });
    setFormError('');
    setFormOpen(true);
  };

  const parsed = picked;

  const save = async () => {
    if (!begin('save')) return;
    try {
      const res = await apiFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limitMb: parsed.mb }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      setConfirm(null);
      if (res.status === 202) {
        // The server answers 202 when this save started a rebuild.
        setFormOpen(false);
        removeJobRef.current = typeof body?.id === 'number' ? body.id : null;
        setRemoving(true);
        onStarted?.();
      } else {
        setInfo(body as LimitInfo);
        setFormOpen(false);
      }
    } catch (e: any) {
      setConfirm(null);
      setFormError(e?.message || 'Could not save the memory limit');
    } finally {
      end();
    }
  };

  const remove = async () => {
    if (!begin('remove')) return;
    try {
      const res = await apiFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limitMb: null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      setConfirm(null);
      setFormOpen(false);
      if (res.status === 202) {
        removeJobRef.current = typeof body?.id === 'number' ? body.id : null;
        setRemoving(true);
        onStarted?.();
      } else {
        setInfo(body as LimitInfo);
      }
    } catch (e: any) {
      setConfirm(null);
      setFormError(e?.message || 'Could not remove the memory limit');
    } finally {
      end();
    }
  };

  const onSaveClick = () => {
    if (parsed.error) { setFormError(parsed.error); return; }
    if (parsed.mb === null) {
      if (info?.limitMb) setConfirm('remove');
      else setFormOpen(false);
      return;
    }
    if (info?.usageMb != null && parsed.mb < info.usageMb) { setConfirm('below'); return; }
    void save();
  };

  if (loadError && !info) return <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--red)' }}>{loadError}</div>;
  if (!info) return null;

  const limit = info.limitMb;
  const share = limit && info.usageMb != null ? info.usageMb / limit : null;
  const warn = share !== null && share >= WARN_SHARE;
  const text = limit === null
    ? formatLimit(null)
    : info.usageMb != null ? `${formatMb(info.usageMb)} of ${formatLimit(limit)}` : formatLimit(limit);
  const disabled = agentBusy || removing || action !== null;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
        <span style={{ color: '#888' }}>Memory limit</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'right' }}>
          <span style={{ color: warn ? 'var(--yellow)' : 'var(--text)' }}>{removing ? 'removing…' : text}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={openForm}
            title={agentBusy ? 'An operation is running on this agent' : 'Set or remove the memory limit'}
          >
            Edit
          </Button>
        </span>
      </div>
      {oomAt !== null && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--red)', borderBottom: '1px solid var(--border)' }}>
          Out of memory {relativeTime(oomAt, Date.now())}: a process was killed.
        </div>
      )}
      {removeError && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--red)', borderBottom: '1px solid var(--border)' }}>
          Could not remove the memory limit: {removeError}
        </div>
      )}
      {loadError && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--yellow)', borderBottom: '1px solid var(--border)' }}>
          Could not refresh the memory limit ({loadError}).
        </div>
      )}

      {/* Stays mounted while a confirm is open (the confirm is drawn over it), so what the picker shows is always what Save sends. */}
      <Modal open={formOpen} onClose={() => { if (!action && confirm === null) setFormOpen(false); }} title="Memory limit" maxWidth={420}>
        <MemoryLimitPicker
          value={info.limitMb}
          dockerTotalMb={info.dockerTotalMb}
          disabled={action !== null}
          onChange={(mb, error) => { setPicked({ mb, error }); setFormError(''); }}
        >
          <div style={{ fontSize: 11, color: '#888', margin: '6px 0 0' }}>
            The limit is the total the agent can use, swap included. Applied now, without a restart.
          </div>
          {formError && <div className="ui-field__error">{formError}</div>}
        </MemoryLimitPicker>
        <div style={{ height: 16 }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {limit !== null && (
            <Button type="button" variant="danger" size="sm" loading={action === 'remove'} disabled={action !== null} onClick={() => setConfirm('remove')}>
              {action === 'remove' ? 'Removing…' : 'Remove limit'}
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" disabled={action !== null} onClick={() => setFormOpen(false)}>
            Cancel
          </Button>
          <Button type="button" variant="primary" size="sm" loading={action === 'save'} disabled={action !== null} onClick={onSaveClick}>
            {action === 'save' ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Modal>

      <Modal
        open={confirm !== null}
        onClose={() => { if (!action) setConfirm(null); }}
        title={confirm === 'remove' ? 'Remove the memory limit?' : 'Limit below current usage'}
        tone={confirm === 'remove' ? 'danger' : 'warning'}
        maxWidth={420}
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, color: '#aaa', marginBottom: 24 }}>
          {confirm === 'remove'
            ? 'Removing the limit rebuilds the container: the agent restarts (no backup, the data volume is kept).'
            : `This agent uses ${formatMb(info.usageMb)} now. A limit below that kills its processes at once and restarts it.`}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" size="sm" disabled={action !== null} onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          {confirm === 'remove' ? (
            <Button type="button" variant="danger" size="sm" loading={action === 'remove'} disabled={action !== null} onClick={() => { void remove(); }}>
              {action === 'remove' ? 'Removing…' : 'Remove limit'}
            </Button>
          ) : (
            <Button type="button" variant="primary" size="sm" loading={action === 'save'} disabled={action !== null} onClick={() => { void save(); }}>
              {action === 'save' ? 'Saving…' : 'Set limit'}
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}

const note = (text: string) => <div style={{ padding: '12px 14px', fontSize: 12, color: '#888' }}>{text}</div>;

export default function ResourceSection({ container, agentId, agentBusy = false, onStarted }: {
  container: string;
  agentId: string;
  /** A long operation runs on the agent: its limit cannot be changed now. */
  agentBusy?: boolean;
  /** The removal rebuild started: the page shows its edit banner at once. */
  onStarted?: () => void;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch('/api/metrics/containers?range=24h', { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
        setData(body as Overview);
        setError('');
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message || 'Could not load the resources');
      }
    };
    setData(null);
    setError('');
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [container]);

  const limitRow = <MemoryLimitRow agentId={agentId} container={container} agentBusy={agentBusy} onStarted={onStarted} />;
  const withLimit = (content: ReactNode) => <div>{limitRow}{content}</div>;

  if (error && !data) return withLimit(<div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--red)' }}>{error}</div>);
  if (!data) return withLimit(note('Loading…'));
  if (!data.available) return withLimit(note(`No samples yet: the Rev4a daemon samples the containers every ${data.interval_s} s.`));

  const row = data.containers?.find((c) => c.container === container);
  if (!row) return withLimit(note('Not sampled in the last 24 h: the agent was not running.'));
  // The same three-intervals rule as the System page: a daemon that stopped must not present
  // hours-old figures as "now".
  const stale = data.age_s != null && data.age_s > data.interval_s * 3;
  const r = row.range;
  const n = row.now;

  return (
    <div>
      {limitRow}
      {error && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--yellow)', borderBottom: '1px solid var(--border)' }}>
          Could not refresh ({error}): showing the last answer.
        </div>
      )}
      {stale ? (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--yellow)', borderBottom: '1px solid var(--border)' }}>
          Not collecting: the latest sample is {Math.round((data.age_s ?? 0) / 60)} min old. Check that the Rev4a daemon is running; the figures below are from when it last answered.
        </div>
      ) : row.running && n ? (
        <>
          <PanelRow label="CPU now" value={`${formatSharePercent(n.cpu_percent)} of Docker's cores${n.cpu_cores !== null ? ` · ${n.cpu_cores.toFixed(3)} cores` : ''}`} />
          <PanelRow label="Memory now" value={`${formatMb(n.mem_mb)}${n.mem_percent !== null ? ` · ${n.mem_percent}% of Docker's memory` : ''}`} />
          <PanelRow label="Processes" value={String(n.pids ?? '—')} />
          <PanelRow label="Network" value={`↓ ${formatRate(n.net_rx_bps)} ↑ ${formatRate(n.net_tx_bps)}`} />
        </>
      ) : (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--yellow)', borderBottom: '1px solid var(--border)' }}>
          Stopped: the figures below are from when it last ran.
        </div>
      )}
      <PanelRow label="CPU · last 24 h" value={`avg ${formatSharePercent(r.cpu_avg_percent)} · peak ${formatSharePercent(r.cpu_max_percent)}`} />
      <PanelRow label="Memory · last 24 h" value={`avg ${formatMb(r.mem_avg_mb)} · peak ${formatMb(r.mem_max_mb)}`} />
      <PanelRow
        label="Storage"
        value={`${formatMb(row.storage.total_mb)}${row.storage.volume_mb !== null ? ` · volume ${formatMb(row.storage.volume_mb)}` : ''}${row.storage.layer_mb !== null ? ` · layer ${formatMb(row.storage.layer_mb)}` : ''}`}
      />
      <div style={{ padding: '8px 14px', fontSize: 11 }}>
        <Link href={`/system?agent=${encodeURIComponent(container)}`} className="ui-link">Charts on the System page →</Link>
      </div>
    </div>
  );
}
